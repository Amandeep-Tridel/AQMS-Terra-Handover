/*
 * Run the reference code on real test-station data, start to finish (same as python/run_sample.py).
 *
 *   node run_sample.js                         # the saved live data, 2 Nov 2026
 *   node run_sample.js --live                  # the latest records from the live database
 *   node run_sample.js --sample ../../04_Templates_and_test_values/Sample_station_data_test_unit.csv
 *   node run_sample.js --no-temperature        # the 20 degC formulas, no temperature correction
 *
 * NH3 and H2S use their site zero with the factory-sheet sensitivity; VOC uses datasheet
 * typical values (../calibration/calibration_records.json). A channel stuck at the ADC rail
 * is reported as a sensor fault, not as a number.
 * Temperature: the station sends no sensor temperature, so the Open-Meteo hourly air
 * temperature at the Tridel Dubai office stands in for it (saved data: the hourly file in
 * 04_Templates_and_test_values; --live: fetched from Open-Meteo). It corrects only the
 * sensitivity of each gas; the H2S zero correction needs the ISB electronic offsets.
 * The test station sends about one reading per minute, so a 10-minute window expects
 * 10 readings and needs 8 valid (the same 80 % as 4 of 5 for 2-minute data).
 * A negative result counts as 0, so the averages never go below 0.
 */

const fs = require("fs");
const path = require("path");
const aqms = require("./aqms_reference");

const DATA = path.join(__dirname, "..", "..", "04_Templates_and_test_values");
const DEFAULT_SAMPLE = path.join(DATA, "Live_station_data_2026-11-02.csv");
const HOURLY_TEMPERATURE = path.join(DATA, "Open_Meteo_hourly_temperature_Tridel_office.csv");
const DEFAULT_CALIBRATION = path.join(__dirname, "..", "calibration", "calibration_records.json");
const LIVE_URL = "https://aqms-65300-default-rtdb.firebaseio.com/data.json";
// Tridel Dubai office: QD01, DAFZA Industrial Park, Al Qusais Industrial Area 5 (Open-Meteo grid 25.318 N, 55.394 E)
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast?latitude=25.28934&longitude=55.40345" +
  "&hourly=temperature_2m&past_days=2&forecast_days=1&timezone=UTC";
const GASES = ["H2S", "NH3", "VOC"];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Minimal CSV reader that handles quoted fields (the raw_string column contains commas). */
function readCsv(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.length);
  const split = (line) => {
    const out = []; let cur = ""; let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted && c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = !quoted;
      else if (c === "," && !quoted) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [header[i], v])));
}

async function readLive(count) {
  const url = `${LIVE_URL}?orderBy=${encodeURIComponent('"$key"')}&limitToLast=${count}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`live database answered ${res.status}`);
  const records = Object.values(await res.json());
  return records.map(aqms.parseFirebaseRecord).sort((a, b) => a.time - b.time);
}

/** { "YYYY-MM-DDTHH": degC } from the saved hourly file, plus Open-Meteo itself for --live. */
async function hourlyTemperatures(live) {
  const temps = {};
  if (fs.existsSync(HOURLY_TEMPERATURE)) {
    for (const row of readCsv(HOURLY_TEMPERATURE)) {
      if (row.temperature_2m_c !== "") temps[row.hour_utc.slice(0, 13)] = Number(row.temperature_2m_c);
    }
  } else {
    console.log(`warning: ${HOURLY_TEMPERATURE} not found: saved readings get no temperature correction`);
  }
  if (live) {
    const res = await fetch(OPEN_METEO_URL);
    if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
    const { hourly } = await res.json();
    hourly.time.forEach((t, i) => { if (hourly.temperature_2m[i] !== null) temps[t.slice(0, 13)] = hourly.temperature_2m[i]; });
  }
  return temps;
}

const iso = (t) => t.toISOString().replace(/\.\d{3}Z$/, "Z"); // 2026-11-02T07:40:22Z, as the Python version writes
const fmt = (v, places = 4) => (v === null || v === undefined ? "" : v.toFixed(places));
const csvLine = (cells) => cells.map((c) => (/[",]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",");

async function main() {
  const live = process.argv.includes("--live");
  const sample = arg("--sample", DEFAULT_SAMPLE);
  const station = arg("--station", "aqms-monitor");
  const records = aqms.loadRecords(arg("--calibration", DEFAULT_CALIBRATION));
  const packets = live ? await readLive(Number(arg("--count", 300)))
    : readCsv(sample).map((row) => aqms.parsePacket(row.raw_string));
  const temps = process.argv.includes("--no-temperature") ? {} : await hourlyTemperatures(live);

  const windows = new Map();
  const rows = [];
  for (const p of packets) {
    const tempC = temps[p.time.toISOString().slice(0, 13)] ?? null;
    const gas = aqms.convertReading(records, station, p.time, { ...p, sensorTempC: tempC });
    const start = new Date(p.time);
    start.setUTCMinutes(Math.floor(start.getUTCMinutes() / 10) * 10, 0, 0);
    const key = iso(start);
    if (!windows.has(key)) windows.set(key, { H2S: [], NH3: [], VOC: [] });
    for (const g of GASES) windows.get(key)[g].push(gas[g].value);
    rows.push([iso(p.time), fmt(p.h2sWeMv, 2), fmt(p.h2sAeMv, 2), fmt(p.nh3WeMv, 2), fmt(p.vocMv, 2), fmt(tempC, 1),
      ...GASES.flatMap((g) => [fmt(gas[g].value), gas[g].reason]),
      ...GASES.map((g) => fmt(gas[g].valid ? gas[g].sensitivityPct : null, 2))]);
  }

  const readingsOut = path.join(__dirname, "output_readings.csv");
  const averagesOut = path.join(__dirname, "output_10min_averages.csv");
  fs.writeFileSync(readingsOut, [
    "time_utc,h2s_we_mv,h2s_ae_mv,nh3_we_mv,voc_mv,open_meteo_temp_c,h2s_ppb,h2s_invalid_reason,nh3_ppm,nh3_invalid_reason," +
      "voc_ppm,voc_invalid_reason,h2s_sensitivity_pct,nh3_sensitivity_pct,voc_sensitivity_pct",
    ...rows.map(csvLine),
  ].join("\n") + "\n");
  fs.writeFileSync(averagesOut, [
    "window_start_utc,readings,h2s_ppb_10min,nh3_ppm_10min,voc_ppm_10min",
    ...[...windows.keys()].sort().map((k) => {
      const w = windows.get(k);
      return csvLine([k, w.NH3.length, ...GASES.map((g) => fmt(aqms.windowAverage(w[g], 8)))]);
    }),
  ].join("\n") + "\n");

  const withTemp = rows.filter((r) => r[5] !== "").length;
  console.log(`${rows.length} readings from ${live ? "live database" : path.basename(sample)} (${withTemp} with Open-Meteo temperature) -> ${readingsOut}`);
  console.log(`${windows.size} ten-minute windows -> ${averagesOut}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
