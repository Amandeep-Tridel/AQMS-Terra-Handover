/*
 * AQMS reference code for the Terra team, in ONE file you can copy and paste.
 * ==========================================================================
 *
 * What this file does, in plain words
 * -----------------------------------
 * A gas station on a pole sends us small voltages (millivolts, "mV") from three gas
 * sensors. This file turns those voltages into gas numbers, makes the 10-minute
 * averages, and decides when an alarm starts and stops. It does exactly what the
 * handover note says, using only Alphasense's own formulas (Alphasense makes the
 * sensors) and Dubai Municipality's (DM) rules. Nothing is smoothed, filtered or guessed.
 *
 * How to use it
 * -------------
 * Copy this file into your project. It needs Node 18 or newer and nothing else (no
 * npm install). In a browser it works too, except loadRecords(), which reads a file:
 * there, fetch the JSON yourself and pass it to recordsFromJson(). For example:
 *
 *   const aqms = require("./aqms_reference");
 *
 *   const records = aqms.loadRecords("calibration_records.json");  // the calibration numbers
 *   const reading = aqms.parseFirebaseRecord(recordFromStation);    // the station's JSON record
 *   const gas = aqms.convertReading(records, "aqms-monitor", reading.time,
 *     { ...reading, sensorTempC: 32.6 });                           // temperature, if you have one
 *   console.log(gas.H2S.value, gas.NH3.value, gas.VOC.value);
 *
 * The file is in five parts, in the same order as the handover note:
 *   PART 1  Turning voltages into gas (the three Alphasense recipes)
 *   PART 2  Temperature correction
 *   PART 3  Calibration records: which numbers to use for which reading
 *   PART 4  Reading what the station sends
 *   PART 5  Averages, alarms and equipment (technical) alarms
 *
 * The Python file aqms_reference.py is the same code, line for line, in Python.
 * Both pass the same checks (test/test_reference.js and tests/test_reference.py).
 *
 * A few words used everywhere below
 * ---------------------------------
 *   mV           millivolt, the tiny electric signal a sensor gives out.
 *   WE           "working electrode": the part of a gas sensor that touches the gas.
 *   AE           "auxiliary electrode": a twin part that never touches the gas. It only
 *                feels heat, so taking it away removes most of the heat effect (H2S only).
 *   zero         what a sensor reads when there is NO gas. We always subtract it.
 *   sensitivity  how many mV the sensor gives for each ppb or ppm of gas.
 *   ppm / ppb    parts per million / parts per billion. 1 ppm = 1,000 ppb.
 *   null         "no value". A reading with no valid number is null, never 0, so it is
 *                left out of averages instead of pulling them down.
 */

"use strict";

// =============================================================================
// PART 1  Turning voltages into gas (the three Alphasense recipes)
// =============================================================================
//
// Every recipe is the same idea: take the zero away, then divide by the sensitivity.
//
//     gas = (voltage now - zero voltage) / sensitivity
//
// Example: a sensor reads 320 mV, its zero is 270 mV and it gives 5 mV per ppm.
// 320 - 270 = 50 mV of real signal. 50 / 5 = 10 ppm of gas.

// The station's converter (ADC) measures 0 to 2.56 V in 32,768 equal steps.
// So one step is 2560 / 32768 = 0.078 mV.
const ADC_FULL_SCALE_MV = 2560;
const ADC_STEPS = 32768;

// A working sensor gives roughly 90 to 500 mV in clean air, and gas pushes it up
// smoothly. A voltage pressed against the very top (2560 mV) or the very bottom
// (0 mV) is not gas: it means a loose cable, no power, or a short circuit.
// 2550 leaves a 10 mV safety margin below the top.
const RAIL_HIGH_MV = 2550;
const RAIL_LOW_MV = 5;

/**
 * Turn a raw converter number ("counts" or "steps") into millivolts.
 * Only needed when the station sends counts instead of volts.
 * Example: 4702 counts x 2560 / 32768 = 367.34 mV.
 */
function countsToMv(counts, fullScaleMv = ADC_FULL_SCALE_MV, steps = ADC_STEPS) {
  return (counts * fullScaleMv) / steps;
}

/**
 * True when the voltage is stuck at the top or the bottom of the range.
 * "Stuck" means the sensor is not really being measured (unplugged, no power,
 * shorted). Such a reading must get NO gas number. Example: on 3 Nov 2026 the
 * H2S channels sat at 2554 mV for six hours: that is stuck, not gas.
 */
function channelAtRail(mv) {
  return mv >= RAIL_HIGH_MV || mv <= RAIL_LOW_MV;
}

/**
 * H2S (sensor H2S-B4, 4 electrodes), in ppb.
 *
 *     H2S = ((WE - WE zero) - (AE - AE zero)) / sensitivity
 *
 * Step by step:
 *   1. WE signal = WE - WE zero       (what the gas side gives above its zero)
 *   2. AE signal = AE - AE zero       (what the heat alone did to the twin)
 *   3. corrected = WE signal - AE signal   (gas only, heat effect removed)
 *   4. H2S = corrected / sensitivity
 *
 * This is Alphasense's note AAN 803-05, Algorithm 3, at 20 degC.
 * Example: ((300 - 250) - (280 - 260)) / 0.4 = (50 - 20) / 0.4 = 75 ppb.
 */
function h2sPpb(weMv, weZeroMv, aeMv, aeZeroMv, sensitivityMvPerPpb) {
  const weSignal = weMv - weZeroMv;
  const aeSignal = aeMv - aeZeroMv;
  return (weSignal - aeSignal) / sensitivityMvPerPpb;
}

/**
 * NH3 (sensor NH3-B1, 3 electrodes), in ppm.
 *
 *     NH3 = (WE - WE zero) / sensitivity
 *
 * The NH3 sensor has no AE twin, so there is nothing to take away for heat.
 * Alphasense: "just leave the AE out". This is AAN 803-05 Algorithm 4 at 20 degC.
 * Example on the test station: (449.31 - 420) / 58.624 = 0.50 ppm.
 */
function nh3Ppm(weMv, weZeroMv, sensitivityMvPerPpm) {
  return (weMv - weZeroMv) / sensitivityMvPerPpm;
}

/**
 * VOC (sensor PIDX-A-040, the "PID"), in ppm, as isobutylene.
 *
 *     VOC = (V - V zero) / sensitivity
 *
 * Isobutylene is just the reference gas the PID is compared against.
 * Example: (150 - 40) / 55 = 2 ppm.
 */
function vocPpm(vMv, vZeroMv, sensitivityMvPerPpm) {
  return (vMv - vZeroMv) / sensitivityMvPerPpm;
}

/**
 * A PID voltage BELOW its lowest normal value means a broken sensor, not clean air.
 * The PID datasheet says a working PID never goes below 40 mV.
 */
function vocSensorFault(vMv, vZeroMv) {
  return vMv < vZeroMv;
}

// =============================================================================
// PART 2  Temperature correction
// =============================================================================
//
// Heat changes two things in a gas sensor:
//   - its SENSITIVITY (how strongly it answers to gas), for all three sensors, and
//   - its ZERO (what it reads with no gas), handled here for H2S only.
//
// Both corrections need the temperature at the top of the sensor. The station does
// not measure that yet, so for now the Open-Meteo hourly air temperature at the
// station's location stands in for it, and only the SENSITIVITY part is used.
// At 20 degC nothing changes, because all the factory numbers are measured at 20 degC.

// The temperatures the tables below are given at, in degC.
const TABLE3_TEMPS_C = [-30, -20, -10, 0, 10, 20, 30, 40, 50];

// Alphasense note AAN 803-05, Table 3, the H2S-B4 row, copied exactly.
// One row of factors for each of Alphasense's four zero-correction algorithms.
// nT, kT and k'T are plain numbers. k''T is a CURRENT in nA (it matches the H2S-B4
// datasheet's chart: -65, -125 and -180 nA at 30, 40 and 50 degC), so before it can
// be taken away from a voltage it must be multiplied by the board's gain (mV per nA).
const H2S_B4_FACTORS = {
  1: [-0.6, -0.6, 0.1, 0.8, -0.7, -2.5, -2.5, -2.2, -1.8], // nT
  2: [0.2, 0.2, 0, -0.3, 0.3, 1, 1, 0.9, 0.7],             // kT
  3: [-14, -14, 3, 3, 2, 1, -1.2, -1.2, -1.2],             // k'T
  4: [52, 51, 48, 45, 26, 0, -65, -125, -180],             // k''T (nA)
};
// AAN 803-05 Table 2 suggests Algorithm 1 for this sensor type. Table 3 has no NH3-B1
// row, and the NH3-B1 datasheet gives no zero-against-temperature data, so the NH3
// zero is never temperature-corrected.

// How sensitive each sensor is at each temperature, as % of its sensitivity at 20 degC.
// Read off the datasheet charts (the middle of the typical batch shown), so these are
// approximate. Replace them with Alphasense's own numbers if they send them.
// Example: at 30 degC the H2S sensor gives 103 % of its 20 degC signal for the same gas.
const SENSITIVITY_PCT = {
  "H2S-B4": [77, 82, 87, 92, 96, 100, 103, 105.5, 105.5],   // H2S-B4 datasheet, Fig. 1
  "NH3-B1": [116, 112, 104, 100, 98.5, 100, 103, 110, 125], // NH3-B1 datasheet, Fig. 2
};

// 20 degC on the absolute (kelvin) scale. The PID is specified at room temperature.
const IDEAL_GAS_REF_K = 293.15;

/**
 * Look up a table value at any temperature, by drawing a straight line between the
 * two nearest listed temperatures ("linear interpolation").
 * Example: k'T is 1 at 20 degC and -1.2 at 30 degC, so at 25 degC (halfway) it is -0.1.
 * Below -30 degC or above 50 degC, the value at the end of the table is used.
 */
function table3Factor(factors, tempC) {
  const T = TABLE3_TEMPS_C;
  if (tempC <= T[0]) return factors[0];
  if (tempC >= T[T.length - 1]) return factors[factors.length - 1];
  for (let i = 0; i < T.length - 1; i++) {
    if (tempC >= T[i] && tempC <= T[i + 1]) {
      return factors[i] + ((factors[i + 1] - factors[i]) * (tempC - T[i])) / (T[i + 1] - T[i]);
    }
  }
  return null;
}

/**
 * The H2S-B4 zero-correction factor for one algorithm at one temperature.
 * For Algorithm 4 the factor is a current (nA), so it is turned into mV with the
 * board's gain. Without a gain, Algorithm 4 cannot be used: this returns null.
 * Example: k''T at 30 degC is -65 nA; x 0.8 mV/nA = -52 mV.
 */
function aan803Factor(algorithm, tempC, gainMvPerNa = null) {
  const factor = table3Factor(H2S_B4_FACTORS[algorithm], tempC);
  if (algorithm === 4) return gainMvPerNa === null || gainMvPerNa === undefined ? null : factor * gainMvPerNa;
  return factor;
}

/**
 * The H2S working-electrode signal with the heat effect on the zero removed (mV).
 *
 * These are Alphasense's four formulas (AAN 803-05, Table 1). The names:
 *   weU, aeU   the raw WE and AE voltages measured now
 *   weE, aeE   the board's "electronic offsets": what the board itself adds,
 *              printed on the ISB sheet ("Electronic Zero WE / AUX")
 *   weT, aeT   the total zeros (board + sensor), from the site zero or factory sheet
 *   weO, aeO   the sensor's own zeros = total zero - electronic offset
 * The answer still has to be divided by the sensitivity to give ppb.
 * At 20 degC, Algorithm 3 gives exactly the same answer as h2sPpb above.
 */
function aan803CorrectedWe(algorithm, factor, weU, weE, weT, aeU = null, aeE = null, aeT = null) {
  const weO = weT - weE;
  if (algorithm === 4) return weU - weE - weO - factor;
  const aeO = aeT - aeE;
  if (algorithm === 1) return weU - weE - factor * (aeU - aeE);
  if (algorithm === 2) return weU - weE - factor * (weO / aeO) * (aeU - aeE);
  if (algorithm === 3) return weU - weE - (weO - aeO) - factor * (aeU - aeE);
  throw new Error(`unknown AAN 803-05 algorithm ${algorithm}`);
}

/**
 * How sensitive a sensor is at tempC, as % of its 20 degC sensitivity.
 * H2S-B4 and NH3-B1: read from the datasheet chart (tables above).
 * PIDX-A-040: its datasheet says it follows the ideal gas law. Warm air is thinner,
 * so fewer gas molecules reach the sensor: % = 100 x 293.15 / (273.15 + T).
 * Example: at 40 degC the PID gives 93.6 % of its 20 degC signal.
 * An unknown sensor model gives null (no correction).
 */
function sensitivityPct(sensorModel, tempC) {
  const model = String(sensorModel || "").replace(/\+$/, ""); // "NH3-B1+" is the same sensor as "NH3-B1"
  if (SENSITIVITY_PCT[model]) return table3Factor(SENSITIVITY_PCT[model], tempC);
  if (model === "PIDX-A-040") return (100 * IDEAL_GAS_REF_K) / (273.15 + tempC);
  return null;
}

// =============================================================================
// PART 3  Calibration records: which numbers to use for which reading
// =============================================================================
//
// A "calibration record" is one set of numbers for one sensor: its zero(s) and its
// sensitivity, plus where they came from ("source"):
//     "factory"    printed on the sensor's own factory calibration sheet
//     "site_zero"  the zero measured on the station itself in clean air, with the
//                  sensitivity still from the factory sheet (Alphasense's advice)
//     "datasheet"  Alphasense's typical values for that sensor type, used until the
//                  sensor's own sheet arrives (shown as "indicative")
//
// The rules (handover note, "The eight calibration rules"):
//   - A new calibration is always a NEW record. Old records are never edited.
//   - For each reading, use the record whose "valid from" is the latest one that is
//     not after the reading's time.
//   - No record means no number: the reading is marked "calibration missing".
//   - A negative result counts as 0, so every average is made of values of 0 or more.
//   - A channel stuck at the top or bottom of its range gets "sensor fault" and no number.

const UNITS = { H2S: "ppb", NH3: "ppm", VOC: "ppm" };

const numOrNull = (v) => (v === undefined || v === null ? null : Number(v));

/**
 * Turn the records from calibration_records.json (already parsed, { records: [...] },
 * with snake_case names) into the objects this code uses.
 * A record with a number missing is refused straight away, so a half-filled record
 * can never be used by mistake.
 */
function recordsFromJson(data) {
  return data.records.map((row) => {
    const missing = ["valid_from", "we_zero_mv", "sensitivity"].filter((k) => row[k] === null || row[k] === undefined);
    if (row.channel === "H2S" && (row.ae_zero_mv === null || row.ae_zero_mv === undefined)) missing.push("ae_zero_mv");
    if (missing.length) throw new Error(`record ${row.record_id || "?"}: value missing: ${missing.join(", ")}`);
    return {
      recordId: row.record_id || "",           // a name for the record, e.g. "CAL-NH3-SITE-0001"
      stationId: row.station_id,               // which station, e.g. "aqms-monitor"
      channel: row.channel,                    // which gas: "H2S", "NH3" or "VOC"
      validFrom: new Date(row.valid_from),     // from when these numbers apply (UTC)
      weZeroMv: Number(row.we_zero_mv),        // the zero (WE zero for H2S and NH3, V zero for VOC)
      aeZeroMv: numOrNull(row.ae_zero_mv),     // the AE zero, H2S only
      source: row.source || "factory",         // "factory", "site_zero" or "datasheet"
      faultBelowMv: numOrNull(row.fault_below_mv), // VOC: below this the PID is broken (default: its zero)
      sensitivity: Number(row.sensitivity),    // mV per ppb for H2S; mV per ppm for NH3 and VOC
      // Optional, for the H2S zero temperature correction later. Leave them empty until
      // the station sends its sensor temperature and the ISB sheets' numbers are known.
      weElectronicMv: numOrNull(row.we_electronic_mv), // WEe, ISB sheet "Electronic Zero WE"
      aeElectronicMv: numOrNull(row.ae_electronic_mv), // AEe, ISB sheet "Electronic Zero AUX"
      tempAlgorithm: numOrNull(row.temp_algorithm),    // which AAN 803-05 algorithm, 1 to 4
      gainMvPerNa: numOrNull(row.gain_mv_per_na),      // the board's gain; only Algorithm 4 needs it
      sensorModel: row.sensor_model || "",     // e.g. "H2S-B4", "NH3-B1+", "PIDX-A-040"
      sensorSerial: row.sensor_serial || "",
      factorySheetRef: row.factory_sheet_ref || "",
      notes: row.notes || "",
    };
  });
}

/** Read all calibration records from a JSON file (Node only; in a browser use recordsFromJson). */
function loadRecords(path) {
  return recordsFromJson(JSON.parse(require("fs").readFileSync(path, "utf8")));
}

/**
 * The record to use for one reading: same station and gas, and the latest "valid
 * from" that is not after the reading's time. null if there is none.
 * Example: a reading on 1 Nov uses the site-zero record from 28 Oct, not the factory
 * record from 1 Oct, because 28 Oct is later and still before 1 Nov.
 */
function recordInForce(records, stationId, channel, at) {
  let best = null;
  for (const r of records) {
    if (r.stationId === stationId && r.channel === channel && r.validFrom.getTime() <= at.getTime()) {
      if (!best || r.validFrom.getTime() > best.validFrom.getTime()) best = r;
    }
  }
  return best;
}

/**
 * The answer for one gas in one reading:
 *   value                 the gas number, or null when there is no valid number
 *   unit                  "ppb" or "ppm"
 *   valid                 true = a good number; false = see "reason"
 *   reason                why there is no number, e.g. "sensor fault (channel stuck at rail)"
 *   recordId              which calibration record was used
 *   source                "factory", "site_zero" or "datasheet" (show it next to the value)
 *   temperatureCorrected  true when the temperature changed the result
 *   zeroCorrected         true when the H2S zero correction was used
 *   sensitivityPct        the sensitivity used, as % of the 20 degC value
 */
function result(value, unit, valid, reason = "", recordId = "", source = "",
  temperatureCorrected = false, zeroCorrected = false, sensitivityPct = 100) {
  return { value, unit, valid, reason, recordId, source, temperatureCorrected, zeroCorrected, sensitivityPct };
}

/**
 * The H2S signal with the zero corrected for temperature, or null when that cannot be
 * done yet (no temperature, no algorithm chosen, or no electronic offsets).
 */
function h2sCorrectedWe(rec, weMv, aeMv, tempC) {
  if (tempC === null || tempC === undefined || rec.tempAlgorithm === null || rec.tempAlgorithm === undefined ||
      rec.weElectronicMv == null || rec.aeElectronicMv == null || String(rec.sensorModel).replace(/\+$/, "") !== "H2S-B4") return null;
  const factor = aan803Factor(rec.tempAlgorithm, tempC, rec.gainMvPerNa);
  if (factor === null) return null; // Algorithm 4 without the board gain
  return aan803CorrectedWe(rec.tempAlgorithm, factor, weMv, rec.weElectronicMv, rec.weZeroMv,
    aeMv, rec.aeElectronicMv, rec.aeZeroMv);
}

/** One gas of one reading, in the same order as "Terra does all the maths" in the note. */
function convertOne(records, stationId, at, channel, mv, aeMv = null, tempC = null) {
  const unit = UNITS[channel];

  // 1. Find the calibration record. No record means no number.
  const rec = recordInForce(records, stationId, channel, at);
  if (!rec) return result(null, unit, false, "calibration missing");

  // 2. A missing voltage stays missing (it is never replaced by 0).
  if (mv === null || mv === undefined || (channel === "H2S" && (aeMv === null || aeMv === undefined))) {
    return result(null, unit, false, "voltage missing", rec.recordId);
  }

  // 3. A voltage stuck at the top or bottom of its range is a sensor fault, not gas.
  if (channelAtRail(mv) || (aeMv !== null && aeMv !== undefined && channelAtRail(aeMv))) {
    return result(null, unit, false, "sensor fault (channel stuck at rail)", rec.recordId, rec.source);
  }

  // 4. The sensitivity at the sensor's temperature (100 % when there is no temperature).
  const pct = tempC === null || tempC === undefined ? null : sensitivityPct(rec.sensorModel, tempC);
  const sensitivity = rec.sensitivity * (pct === null ? 1 : pct / 100);

  // 5. The recipe for this gas.
  let value;
  let zeroCorrected = false;
  if (channel === "H2S") {
    const weC = h2sCorrectedWe(rec, mv, aeMv, tempC);
    zeroCorrected = weC !== null;
    value = zeroCorrected ? weC / sensitivity : h2sPpb(mv, rec.weZeroMv, aeMv, rec.aeZeroMv, sensitivity);
  } else if (channel === "NH3") {
    value = nh3Ppm(mv, rec.weZeroMv, sensitivity);
  } else {
    const limit = rec.faultBelowMv ?? rec.weZeroMv;
    if (vocSensorFault(mv, limit)) return result(null, unit, false, "sensor fault (below zero)", rec.recordId, rec.source);
    value = vocPpm(mv, rec.weZeroMv, sensitivity);
  }

  // 6. There can never be less than no gas. A small negative number is only noise
  //    around zero, so it counts as 0, and so does every average made from it.
  value = Math.max(0, value);
  return result(value, unit, true, "", rec.recordId, rec.source, pct !== null || zeroCorrected, zeroCorrected, pct === null ? 100 : pct);
}

/**
 * Turn ONE raw reading into H2S (ppb), NH3 (ppm) and VOC (ppm).
 *   at            the reading's time (a Date, UTC)
 *   h2sWeMv, h2sAeMv, nh3WeMv, vocMv   the four voltages in mV (null if missing)
 *   sensorTempC   the temperature at the top of the sensor, in degC: one number for all
 *                 three sensors, or { H2S, NH3, VOC }. Until the station measures it,
 *                 pass the Open-Meteo air temperature for that hour. Leave it out for
 *                 the plain 20 degC formulas.
 * Returns { H2S, NH3, VOC }, each a result as described above.
 */
function convertReading(records, stationId, at,
  { h2sWeMv = null, h2sAeMv = null, nh3WeMv = null, vocMv = null, sensorTempC = null } = {}) {
  const temps = sensorTempC !== null && typeof sensorTempC === "object" ? sensorTempC
    : { H2S: sensorTempC, NH3: sensorTempC, VOC: sensorTempC };
  return {
    H2S: convertOne(records, stationId, at, "H2S", h2sWeMv, h2sAeMv, temps.H2S ?? null),
    NH3: convertOne(records, stationId, at, "NH3", nh3WeMv, null, temps.NH3 ?? null),
    VOC: convertOne(records, stationId, at, "VOC", vocMv, null, temps.VOC ?? null),
  };
}

// =============================================================================
// PART 4  Reading what the station sends
// =============================================================================
//
// The four channels:  A0 = NH3 WE,  A1 = H2S WE (also called OP1),
//                     A2 = H2S AE (OP2),  A3 = VOC (the PID).
//
// The test station sends one JSON record about every minute ("schema 4"). Inside it,
// "combinedString" is the same reading as one line of text. Older records used a
// different line style. All of them are read here:
//
//   the JSON record:   {"timestampUtc": "2026-11-03T09:59:10Z", "device": "aqms-monitor",
//                       "volts": [0.36734, 2.55422, 2.55391, 0.09812], "adcOk": true, ...}
//   the line (now):    2026-11-02,12:47:23,0.34969,0.43008,0.36375,0.10063,NA
//                      -> date, time, then A0, A1, A2, A3 in volts, then the STM32 status
//   the line (older):  2026-10-28,14:19:00,A0:raw=6286|volts=0.49109,A1:raw=6025|volts=0.47070,
//                      A2:raw=4597|volts=0.35914,A3:raw=1333|volts=0.10414,STM32:NA

const FIELDS = ["nh3WeMv", "h2sWeMv", "h2sAeMv", "vocMv"]; // A0, A1, A2, A3, in that order
const CHANNEL = /A([0-3])\s*:\s*raw\s*=\s*(-?\d+(?:\.\d+)?)(?:\s*\|\s*volts\s*=\s*(-?\d+(?:\.\d+)?))?/g;
const STAMP = /^(\d{4}-\d{2}-\d{2})\s*,\s*(\d{2}:\d{2}:\d{2})/;

/**
 * Read one packet LINE (the "combinedString") into a time and four mV values.
 * Returns { time: Date (UTC), nh3WeMv, h2sWeMv, h2sAeMv, vocMv }.
 * Volts are turned into mV (x 1000). "NA" or a missing channel stays null.
 */
function parsePacket(line) {
  const text = line.trim();
  const stamp = STAMP.exec(text);
  if (!stamp) throw new Error("packet has no date and time at the start");
  const out = { time: new Date(`${stamp[1]}T${stamp[2]}Z`), nh3WeMv: null, h2sWeMv: null, h2sAeMv: null, vocMv: null };

  const tagged = [...text.matchAll(CHANNEL)];
  if (tagged.length) { // older A0:raw=..|volts=.. style
    for (const [, ch, counts, volts] of tagged) {
      out[FIELDS[Number(ch)]] = volts !== undefined ? Number(volts) * 1000 : countsToMv(Number(counts));
    }
    return out;
  }
  text.split(",").slice(2, 6).forEach((part, i) => { // current style: four volts in order
    const v = Number(part.trim());
    out[FIELDS[i]] = part.trim() !== "" && Number.isFinite(v) ? v * 1000 : null; // "NA": missing stays missing
  });
  return out;
}

/**
 * Read one whole JSON record from the station (schema 4).
 *
 * What is used, and in what order of preference:
 *   time      timestampUtc; if missing, rtcUtc (the station's clock); if missing,
 *             ntpUtc (internet time); if missing, the date and time in combinedString
 *   voltages  volts (x 1000 = mV); if missing, raw converter counts (x 2560 / 32768);
 *             if missing, combinedString
 *   adcOk     false means the station's converter failed: no voltage can be trusted
 * Passed on for the equipment alarms (never used in a gas formula): batteryV,
 * sampleAgeMs, schemaVersion. Not used at all: a0Volts, h2sDiffV, averageCount,
 * destination and the stm32 block.
 * Returns the same shape as parsePacket, plus stationId, adcOk, batteryV, sampleAgeMs
 * and schemaVersion.
 */
function parseFirebaseRecord(record) {
  const stamp = record.timestampUtc || record.rtcUtc || record.ntpUtc;
  const line = record.combinedString || "";
  const hasVolts = (record.volts && record.volts.length) || (record.raw && record.raw.length);
  const out = line && (!stamp || !hasVolts) ? parsePacket(line) : {};
  if (stamp) out.time = new Date(stamp);
  out.stationId = record.device || null;
  const volts = record.volts || [];
  const raw = record.raw || [];
  FIELDS.forEach((name, i) => {
    if (volts[i] !== undefined && volts[i] !== null) out[name] = Number(volts[i]) * 1000;
    else if (raw[i] !== undefined && raw[i] !== null) out[name] = countsToMv(Number(raw[i]));
    else if (out[name] === undefined) out[name] = null;
  });
  out.adcOk = record.adcOk !== false;
  if (!out.adcOk) FIELDS.forEach((name) => { out[name] = null; }); // a failed converter read gives no voltages
  out.batteryV = record.batteryV ?? null;
  out.sampleAgeMs = record.sampleAgeMs ?? null;
  out.schemaVersion = record.schemaVersion ?? null;
  return out;
}

// =============================================================================
// PART 5  Averages, alarms and equipment (technical) alarms
// =============================================================================
//
// One reading jumps around too much to trust, so Terra averages the readings in each
// 10 minutes, and alarms only ever look at those averages.
// null means "invalid or missing". It is never replaced by 0 or by the last value;
// it is simply left out.

const isValid = (v) => v !== null && v !== undefined;

/**
 * The average of the valid readings in one window, or null if too few are valid.
 * DM's rule: a 10-minute window has five 2-minute readings and needs at least 4 valid
 * ones. (The test station sends one a minute: then use minimumValid = 8 of 10.)
 * Example: 10, 12, (bad), 11, 13 -> four valid -> (10 + 12 + 11 + 13) / 4 = 11.5.
 */
function windowAverage(values, minimumValid = 4) {
  const valid = values.filter(isValid);
  if (valid.length < minimumValid) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

/** The share of the expected readings that are valid, from 0 to 1. */
function periodCompleteness(values, expectedCount) {
  return expectedCount ? values.filter(isValid).length / expectedCount : 0;
}

/** DM's rule: a report period with less than 75 % valid readings is "incomplete". */
function isComplete(values, expectedCount, required = 0.75) {
  return periodCompleteness(values, expectedCount) >= required;
}

/**
 * The average wind direction in degrees (0 to 360), or null if there is none.
 * A normal average does not work for directions: the average of 350 and 10 degrees
 * must be 0 (north), but (350 + 10) / 2 gives 180 (south), exactly backwards.
 * So: average the sines, average the cosines, then turn them back into an angle.
 * Checks: 350 and 10 give 0; 80 and 100 give 90.
 */
function windDirectionAverage(directionsDeg) {
  const valid = directionsDeg.filter(isValid);
  if (valid.length === 0) return null;
  const rad = Math.PI / 180;
  const s = valid.reduce((a, d) => a + Math.sin(d * rad), 0) / valid.length;
  const c = valid.reduce((a, d) => a + Math.cos(d * rad), 0) / valid.length;
  let angle = Math.atan2(s, c) / rad;
  if (angle < 0) angle += 360;
  return (Math.round(angle * 1e6) / 1e6) % 360;
}

const LEVELS = ["Warning", "Action", "Critical"]; // from mild to serious

/**
 * The three alarm lines for one station and one gas (DM's Monitoring Criteria).
 * B = the normal level, S = how much it normally wobbles (both from the 30-day baseline).
 * Each line is the bigger of the alarm floor and B + 2S, 3S or 4S. The floor is there
 * so tiny noise near zero can never start an alarm.
 * Example: B = 5, S = 2, floor = 8 -> Warning 9, Action 11, Critical 13.
 */
function thresholds(baselineB, baselineS, alarmFloor) {
  return {
    Warning: Math.max(alarmFloor, baselineB + 2 * baselineS),
    Action: Math.max(alarmFloor, baselineB + 3 * baselineS),
    Critical: Math.max(alarmFloor, baselineB + 4 * baselineS),
  };
}

/** The middle value of a list (for three values: the one in the middle when sorted). */
function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * A sudden jump: the newest average is at least TWICE the middle value of the three
 * before it, AND above Warning. That starts an Action alarm straight away.
 * Example: the last three were 4, 6 and 5 (middle value 5). The new one is 12.
 * 12 >= 2 x 5 and 12 > Warning 9, so yes.
 */
function rapidRise(previousThree, newest, warningThreshold) {
  if (previousThree.length < 3) return false;
  return newest >= 2 * median(previousThree) && newest > warningThreshold;
}

/**
 * Keeps the alarm for ONE station and ONE gas. There is never more than one alarm
 * open at a time; it just moves up a level if things get worse.
 *
 * Feed it each finished 10-minute window with addWindow(). An invalid window (null)
 * is skipped: it does not count towards "in a row", and it does not break the row either.
 *
 * When an alarm STARTS:
 *   Warning   2 valid 10-minute averages in a row above Warning (or one 30-minute average)
 *   Action    2 in a row above Action (or one 30-minute average), or a rapid rise
 *   Critical  just 1 window above Critical: a Critical level cannot wait
 * When it STOPS ("Cleared"):
 *   3 valid windows in a row below Warning, and for Action and Critical a person must
 *   also have acknowledged it. "Closed" = cleared AND acknowledged.
 */
class AlarmTracker {
  constructor(stationId, gas, levelThresholds) {
    this.stationId = stationId;
    this.gas = gas;
    this.t = levelThresholds;          // { Warning, Action, Critical }
    this.level = null;                 // the level now; null = no alarm
    this.acknowledged = false;
    this.clearedWaitingAck = false;    // a Warning that cleared before anyone acknowledged it
    this.history = [];                 // every event: { time, event, level, value, user }
    this.above = { Warning: 0, Action: 0, Critical: 0 }; // how many windows in a row above each line
    this.belowWarning = 0;             // how many windows in a row below Warning
    this.recent = [];                  // the last three valid 10-minute averages
  }

  /** Feed one finished 10-minute window. Returns the events it caused. */
  addWindow(at, avg10min, avg30min = null) {
    if (avg10min === null || avg10min === undefined) return []; // invalid window: skipped, the row is not broken

    // Count the windows in a row above each line, and below Warning.
    for (const lvl of LEVELS) this.above[lvl] = avg10min > this.t[lvl] ? this.above[lvl] + 1 : 0;
    this.belowWarning = avg10min < this.t.Warning ? this.belowWarning + 1 : 0;

    // Which level's start rule is met now (the highest one wins)?
    const has30 = avg30min !== null && avg30min !== undefined;
    let met = null;
    if (this.above.Warning >= 2 || (has30 && avg30min > this.t.Warning)) met = "Warning";
    if (this.above.Action >= 2 || (has30 && avg30min > this.t.Action)
        || rapidRise(this.recent.slice(-3), avg10min, this.t.Warning)) met = "Action";
    if (avg10min > this.t.Critical) met = "Critical"; // one window is enough; do not wait

    this.recent = [...this.recent, avg10min].slice(-3);
    const events = [];

    // Start a new alarm, or move the open one up a level ("Escalated").
    if (met && (this.level === null || LEVELS.indexOf(met) > LEVELS.indexOf(this.level))) {
      const event = this.level === null ? "Raised" : "Escalated";
      if (this.level === null) this.acknowledged = false;
      this.level = met;
      events.push(this.log(at, event, avg10min));
    }

    // Stop the alarm after 3 windows below Warning (Action and Critical also need an
    // acknowledgement first).
    if (this.level && this.belowWarning >= 3 && (this.level === "Warning" || this.acknowledged)) {
      events.push(this.log(at, "Cleared", avg10min));
      if (this.acknowledged) events.push(this.log(at, "Closed", avg10min));
      else this.clearedWaitingAck = true; // Closed once someone acknowledges
      this.level = null;
      this.acknowledged = false;
    }
    return events;
  }

  /** A person clicks "I have seen this". That alone never clears an alarm. */
  acknowledge(at, user) {
    if (this.level === null) {
      if (!this.clearedWaitingAck) return [];
      this.clearedWaitingAck = false;
      return [this.log(at, "Acknowledged", null, user), this.log(at, "Closed", null)];
    }
    this.acknowledged = true;
    return [this.log(at, "Acknowledged", null, user)];
  }

  log(at, event, value, user = null) {
    const entry = { time: at, event, level: this.level, value, user };
    this.history.push(entry);
    return entry;
  }
}

// Equipment ("technical") alarms. They are about the equipment, not the air. They show
// in Terra for DM, clearly marked as equipment alarms, and DM tells Tridel.

/** True when nothing has arrived for more than 30 minutes (DM's Monitoring Criteria). */
function communicationLost(lastPackageAt, now, timeoutMinutes = 30) {
  return now.getTime() - lastPackageAt.getTime() > timeoutMinutes * 60000;
}

/**
 * True when a gas has shown exactly the same value for more than 60 minutes.
 * Real air never stays exactly the same for an hour, so this means a stuck sensor or
 * logger. timedValues: [{ time, value }], oldest first, valid readings only.
 */
function flatLine(timedValues, minutes = 60) {
  if (timedValues.length < 2) return false;
  const last = timedValues[timedValues.length - 1];
  let start = last.time;
  for (let i = timedValues.length - 1; i >= 0; i--) {
    if (timedValues[i].value !== last.value) break;
    start = timedValues[i].time;
  }
  return last.time.getTime() - start.getTime() > minutes * 60000;
}

const api = {
  // PART 1
  ADC_FULL_SCALE_MV, ADC_STEPS, RAIL_HIGH_MV, RAIL_LOW_MV, countsToMv, channelAtRail,
  h2sPpb, nh3Ppm, vocPpm, vocSensorFault,
  // PART 2
  TABLE3_TEMPS_C, H2S_B4_FACTORS, SENSITIVITY_PCT, table3Factor, aan803Factor, aan803CorrectedWe, sensitivityPct,
  // PART 3
  UNITS, recordsFromJson, loadRecords, recordInForce, convertReading,
  // PART 4
  FIELDS, parsePacket, parseFirebaseRecord,
  // PART 5
  windowAverage, periodCompleteness, isComplete, windDirectionAverage,
  LEVELS, thresholds, rapidRise, AlarmTracker, communicationLost, flatLine,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;   // Node
if (typeof window !== "undefined") window.AQMS = api;                         // browser
