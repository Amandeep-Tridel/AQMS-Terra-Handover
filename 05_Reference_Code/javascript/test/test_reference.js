/*
 * Same checks as python/tests/test_reference.py, using the worked examples in the handover
 * note and AQMS_Formulas_and_Templates.xlsx.   Run:  node test/test_reference.js   (or npm test)
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const a = require("../aqms_reference");

const CAL_DIR = path.join(__dirname, "..", "..", "calibration");
const T0 = new Date("2026-11-01T00:00:00Z");
const BEFORE_SITE_ZERO = new Date("2026-10-15T00:00:00Z"); // only the factory-zero records apply
const at = (minutes) => new Date(T0.getTime() + minutes * 60000);
const near = (x, y, msg = "") => assert.ok(Math.abs(x - y) < 1e-6, `${msg} got ${x}, expected ${y}`);

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`ok    ${name}`); }
  catch (err) { console.log(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

// Formulas
check("H2S worked example = 75 ppb", () => near(a.h2sPpb(300, 250, 280, 260, 0.4), 75));
check("NH3 worked example = 10 ppm", () => near(a.nh3Ppm(320, 270, 5), 10));
check("NH3 factory sheet 77840031", () => near(a.nh3Ppm(349.69, 328, 58.624), (349.69 - 328) / 58.624));
check("VOC worked example = 2 ppm, fault below zero", () => {
  near(a.vocPpm(150, 40, 55), 2);
  assert.ok(!a.vocSensorFault(150, 40));
  assert.ok(a.vocSensorFault(30, 40));
});
check("counts 6246 = 487.97 mV", () => assert.ok(Math.abs(a.countsToMv(6246) - 487.97) < 0.01));

// Calibration
const rec = (id, validFrom, zero, sens) => ({ recordId: id, stationId: "S1", channel: "VOC", validFrom, weZeroMv: zero, aeZeroMv: null, sensitivity: sens });
check("latest record not after reading time", () => {
  const recs = [rec("old", T0, 40, 55), rec("new", at(10 * 24 * 60), 45, 50)];
  assert.strictEqual(a.recordInForce(recs, "S1", "VOC", at(5 * 24 * 60)).recordId, "old");
  assert.strictEqual(a.recordInForce(recs, "S1", "VOC", at(10 * 24 * 60)).recordId, "new");
  assert.strictEqual(a.recordInForce(recs, "S1", "VOC", at(-24 * 60)), null);
});
check("no record means no number", () => {
  const r = a.convertReading([], "S1", T0, { vocMv: 150 }).VOC;
  assert.strictEqual(r.value, null);
  assert.strictEqual(r.reason, "calibration missing");
});
check("site zero in force, factory sensitivity kept", () => {
  const recs = a.loadRecords(path.join(CAL_DIR, "calibration_records.json"));
  const src = Object.fromEntries(["H2S", "NH3", "VOC"].map((g) => [g, a.recordInForce(recs, "aqms-monitor", g, T0).source]));
  assert.deepStrictEqual(src, { H2S: "site_zero", NH3: "site_zero", VOC: "datasheet" });
  const out = a.convertReading(recs, "aqms-monitor", T0, { h2sWeMv: 500, h2sAeMv: 360, nh3WeMv: 449.31, vocMv: 100 });
  near(out.NH3.value, (449.31 - 420) / 58.624);                  // site zero, sheet sensitivity
  assert.strictEqual(out.NH3.recordId, "CAL-NH3-SITE-0001");
  near(out.H2S.value, ((500 - 458) - (360 - 359)) / 1.727952);   // site zeros, sheet sensitivity
  assert.strictEqual(out.H2S.recordId, "CAL-H2S-SITE-0001");
  near(out.VOC.value, (100 - 70) / 55);                          // PIDX datasheet
});
check("factory records kept for earlier readings", () => {
  const recs = a.loadRecords(path.join(CAL_DIR, "calibration_records.json"));
  const out = a.convertReading(recs, "aqms-monitor", BEFORE_SITE_ZERO, { h2sWeMv: 430, h2sAeMv: 364, nh3WeMv: 349.69 });
  assert.deepStrictEqual([out.NH3.recordId, out.H2S.recordId], ["CAL-NH3-0001", "CAL-H2S-0002"]);
  near(out.NH3.value, (349.69 - 328) / 58.624);
  near(out.H2S.value, ((430 - 395) - (364 - 362)) / 1.727952);
});
check("site zero reads zero in the clean hours", () => {
  const recs = a.loadRecords(path.join(CAL_DIR, "calibration_records.json"));
  const out = a.convertReading(recs, "aqms-monitor", T0, { h2sWeMv: 458.05, h2sAeMv: 359.06, nh3WeMv: 420.08 });
  assert.ok(out.NH3.value < 0.01); // the factory zero would give 1.57 ppm here
  assert.ok(out.H2S.value < 1);    // the factory zero would give 38 ppb here
});
check("H2S factory sheet worked example = 0.1545 ppm", () => {
  const recs = a.loadRecords(path.join(CAL_DIR, "calibration_records.json"));
  const ppb = a.convertReading(recs, "aqms-monitor", BEFORE_SITE_ZERO, { h2sWeMv: 600, h2sAeMv: 300 }).H2S.value;
  near(ppb / 1000, 267 / 1727.952);
  assert.ok(Math.abs(ppb / 1000 - 0.1545) < 0.00005);
});
check("negative result counts as zero", () => {
  const recs = a.loadRecords(path.join(CAL_DIR, "calibration_records.json"));
  const out = a.convertReading(recs, "aqms-monitor", T0, { h2sWeMv: 347.81, h2sAeMv: 401.25, nh3WeMv: 300, vocMv: 55 });
  assert.deepStrictEqual([out.H2S.value, out.NH3.value, out.VOC.value], [0, 0, 0]);
  assert.ok(out.NH3.valid);
  assert.ok(Object.is(out.NH3.value, 0)); // +0, never -0
  near(a.windowAverage([0, 0, 3, 1]), 1);
});
check("VOC fault only below datasheet minimum", () => {
  const recs = a.loadRecords(path.join(CAL_DIR, "calibration_records.json"));
  assert.ok(a.convertReading(recs, "aqms-monitor", T0, { vocMv: 55 }).VOC.valid);
  assert.strictEqual(a.convertReading(recs, "aqms-monitor", T0, { vocMv: 35 }).VOC.reason, "sensor fault (below zero)");
});
check("channel stuck at rail is a fault", () => {
  const recs = a.loadRecords(path.join(CAL_DIR, "calibration_records.json"));
  // 3 Nov 2026: A1 and A2 stuck at full scale from 06:47 UTC; A0 at 2.19 mV at 06:47 UTC
  const out = a.convertReading(recs, "aqms-monitor", T0, { h2sWeMv: 2560.86, h2sAeMv: 2560.78, nh3WeMv: 2.19, vocMv: 97.97 });
  for (const gas of ["H2S", "NH3"]) {
    assert.strictEqual(out[gas].value, null);
    assert.strictEqual(out[gas].reason, "sensor fault (channel stuck at rail)");
  }
  assert.ok(out.VOC.valid);
  assert.strictEqual(a.convertReading(recs, "aqms-monitor", T0, { h2sWeMv: 450, h2sAeMv: 2555 }).H2S.value, null);
});
check("template cannot be loaded until filled", () => {
  assert.throws(() => a.loadRecords(path.join(CAL_DIR, "calibration_template_to_fill.json")), /value missing/);
});
check("filled H2S record works", () => {
  const file = path.join(os.tmpdir(), `aqms_h2s_${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ records: [{ record_id: "X", station_id: "S1", channel: "H2S",
    valid_from: "2026-10-01T00:00:00Z", we_zero_mv: 250, ae_zero_mv: 260, sensitivity: 0.4 }] }));
  try {
    const recs = a.loadRecords(file);
    near(a.convertReading(recs, "S1", T0, { h2sWeMv: 300, h2sAeMv: 280 }).H2S.value, 75);
  } finally { fs.unlinkSync(file); }
});

// Temperature correction: AAN 803-05 Tables 1 and 3 (zero, H2S) and the datasheet sensitivity curves (all three)
check("Table 3 interpolation", () => {
  const k3 = a.H2S_B4_FACTORS[3];
  assert.strictEqual(a.table3Factor(k3, 20), 1);
  near(a.table3Factor(k3, 25), -0.1);                               // halfway between 1 and -1.2
  assert.strictEqual(a.table3Factor(k3, 45), -1.2);
  assert.strictEqual(a.table3Factor(a.H2S_B4_FACTORS[4], 60), -180); // outside the table: end value
});
check("k''T is nA and needs the board gain", () => {
  near(a.aan803Factor(4, 30, 0.8), -52); // -65 nA x 0.8 mV/nA
  assert.strictEqual(a.aan803Factor(4, 30), null);
  near(a.aan803Factor(3, 35), -1.2);
});
check("sensitivity curves", () => {
  assert.strictEqual(a.sensitivityPct("H2S-B4", 20), 100);
  near(a.sensitivityPct("H2S-B4", 35), 104.25);
  near(a.sensitivityPct("NH3-B1+", 40), 110);
  near(a.sensitivityPct("PIDX-A-040", 20), 100);
  near(a.sensitivityPct("PIDX-A-040", 40), (100 * 293.15) / 313.15); // ideal gas law
  assert.strictEqual(a.sensitivityPct("unknown", 40), null);
});
check("AAN 803-05 algorithms worked example", () => {
  // WEu 500, AEu 360, WEe 300, AEe 310, WEt 458, AEt 359  ->  WEo 158, AEo 49
  near(a.aan803CorrectedWe(1, -2.5, 500, 300, 458, 360, 310, 359), 200 + 2.5 * 50);
  near(a.aan803CorrectedWe(2, 1, 500, 300, 458, 360, 310, 359), 200 - (158 / 49) * 50);
  near(a.aan803CorrectedWe(3, 1, 500, 300, 458, 360, 310, 359), 200 - 109 - 50);
  near(a.aan803CorrectedWe(4, 0, 500, 300, 458), 200 - 158);
});
check("algorithm 3 at 20 degC equals the plain formula", () => {
  const weC = a.aan803CorrectedWe(3, a.aan803Factor(3, 20), 500, 300, 458, 360, 310, 359);
  near(weC / 1.727952, a.h2sPpb(500, 458, 360, 359, 1.727952));
});
check("no temperature changes nothing", () => {
  const recs = a.loadRecords(path.join(CAL_DIR, "calibration_records.json"));
  const out = a.convertReading(recs, "aqms-monitor", T0, { h2sWeMv: 500, h2sAeMv: 360, nh3WeMv: 449.31, vocMv: 100 });
  for (const g of ["H2S", "NH3", "VOC"]) {
    assert.strictEqual(out[g].temperatureCorrected, false);
    assert.strictEqual(out[g].sensitivityPct, 100);
  }
});
check("sensitivity only without electronic offsets", () => {
  const recs = a.loadRecords(path.join(CAL_DIR, "calibration_records.json"));
  const out = a.convertReading(recs, "aqms-monitor", T0, { h2sWeMv: 500, h2sAeMv: 360, nh3WeMv: 449.31, vocMv: 100, sensorTempC: 40 });
  assert.strictEqual(out.H2S.temperatureCorrected, true);
  assert.strictEqual(out.H2S.zeroCorrected, false);
  near(out.H2S.value, ((500 - 458) - (360 - 359)) / (1.727952 * 1.055));
  near(out.NH3.value, (449.31 - 420) / (58.624 * 1.1));
  near(out.VOC.value, ((100 - 70) / 55) * (313.15 / 293.15)); // PID reads low when hot
  near(a.convertReading(recs, "aqms-monitor", T0, { h2sWeMv: 500, h2sAeMv: 360, sensorTempC: 20 }).H2S.value, ((500 - 458) - (360 - 359)) / 1.727952);
});
check("zero and sensitivity with electronic offsets", () => {
  const recs = a.recordsFromJson({ records: [{ record_id: "T", station_id: "S1", channel: "H2S", sensor_model: "H2S-B4",
    valid_from: "2026-11-01T00:00:00Z", we_zero_mv: 458, ae_zero_mv: 359, sensitivity: 1.727952,
    we_electronic_mv: 300, ae_electronic_mv: 310, temp_algorithm: 3 }] });
  const r = a.convertReading(recs, "S1", T0, { h2sWeMv: 500, h2sAeMv: 360, sensorTempC: 35 }).H2S;
  assert.strictEqual(r.zeroCorrected, true);
  near(r.value, (200 - 109 + 1.2 * 50) / (1.727952 * 1.0425)); // k'T -1.2, sensitivity 104.25 %
  near(a.convertReading(recs, "S1", T0, { h2sWeMv: 500, h2sAeMv: 360, sensorTempC: 20 }).H2S.value, ((500 - 458) - (360 - 359)) / 1.727952);
  assert.strictEqual(a.convertReading(recs, "S1", T0, { h2sWeMv: 500, h2sAeMv: 360 }).H2S.temperatureCorrected, false);
});
check("algorithm 4 needs the board gain", () => {
  const row = { record_id: "T", station_id: "S1", channel: "H2S", sensor_model: "H2S-B4", valid_from: "2026-11-01T00:00:00Z",
    we_zero_mv: 458, ae_zero_mv: 359, sensitivity: 1.727952, we_electronic_mv: 300, ae_electronic_mv: 310, temp_algorithm: 4 };
  const noGain = a.recordsFromJson({ records: [row] });
  assert.strictEqual(a.convertReading(noGain, "S1", T0, { h2sWeMv: 500, h2sAeMv: 360, sensorTempC: 30 }).H2S.zeroCorrected, false);
  const withGain = a.recordsFromJson({ records: [{ ...row, gain_mv_per_na: 0.8 }] });
  const r = a.convertReading(withGain, "S1", T0, { h2sWeMv: 500, h2sAeMv: 360, sensorTempC: 30 }).H2S;
  assert.strictEqual(r.zeroCorrected, true);
  near(r.value, (200 - 158 + 52) / (1.727952 * 1.03)); // k''T -65 nA x 0.8 = -52 mV
});

// Packets
check("current live packet style", () => {
  const p = a.parsePacket("2026-11-02,12:47:23,0.34969,0.43008,0.36375,0.10063,NA");
  assert.strictEqual(p.time.toISOString(), "2026-11-02T12:47:23.000Z");
  near(p.nh3WeMv, 349.69); near(p.h2sWeMv, 430.08); near(p.h2sAeMv, 363.75); near(p.vocMv, 100.63);
});
check("older packet style", () => {
  const p = a.parsePacket("2026-10-28,14:16:00,A0:raw=6246|volts=0.48797,A1:raw=6013|volts=0.46977,A2:raw=4622|volts=0.36109,A3:raw=1342|volts=0.10484,STM32:NA");
  near(p.h2sAeMv, 361.09);
});
check("missing channel stays missing", () => assert.strictEqual(a.parsePacket("2026-11-02,12:47:23,0.34969,NA,0.36375,0.10063,NA").h2sWeMv, null));
check("live Firebase record", () => {
  const p = a.parseFirebaseRecord({ timestampUtc: "2026-11-02T12:47:23Z", device: "aqms-monitor",
    volts: [0.34969, 0.43008, 0.36375, 0.10063], raw: [4476, 5505, 4656, 1288] });
  assert.strictEqual(p.stationId, "aqms-monitor");
  near(p.vocMv, 100.63);
});

// The full schema-4 record the station sends (04_Templates_and_test_values/Station_record_example_schema4.json)
const RECORD = {"a0Volts":0.36734,"adcOk":true,"averageCount":1,"batteryV":11.7587,"combinedString":"2026-11-03,09:59:10,0.36734,2.55422,2.55391,0.09812,NA","destination":"client","device":"aqms-monitor","h2sDiffV":0.00031,"ntpUtc":"2026-11-03T09:59:11Z","raw":[4702,32694,32690,1256],"rtcUtc":"2026-11-03T09:59:10Z","sampleAgeMs":3419,"schemaVersion":4,"stm32":{"available":false,"echoIgnored":0,"fresh":false,"messageCount":0,"rejectedCount":0,"reset":{"ackCount":0,"ackKind":"none","cooldownRemainingMs":0,"remainingMs":0,"state":"idle","timeoutSeconds":30}},"timestampUtc":"2026-11-03T09:59:10Z","volts":[0.36734,2.55422,2.55391,0.09812]};
check("station record fields", () => {
  const p = a.parseFirebaseRecord(RECORD);
  assert.strictEqual(p.time.toISOString(), "2026-11-03T09:59:10.000Z");
  assert.deepStrictEqual([p.stationId, p.adcOk, p.batteryV, p.schemaVersion], ["aqms-monitor", true, 11.7587, 4]);
  near(p.h2sWeMv, 2554.22);
  assert.ok(Math.abs(a.countsToMv(RECORD.raw[1]) - 2554.22) < 0.05); // counts agree with volts
  near(p.h2sWeMv - p.h2sAeMv, RECORD.h2sDiffV * 1000);
});
check("station record through the formulas", () => {
  const recs = a.loadRecords(path.join(CAL_DIR, "calibration_records.json"));
  const p = a.parseFirebaseRecord(RECORD);
  const out = a.convertReading(recs, "aqms-monitor", p.time, { ...p, sensorTempC: 32.6 }); // Open-Meteo, 09:00 UTC
  assert.strictEqual(out.H2S.reason, "sensor fault (channel stuck at rail)"); // A1 2554.22 mV >= 2550
  assert.strictEqual(out.NH3.value, 0);                                      // 367.34 - 420 < 0 -> 0
  near(out.VOC.value, (98.12 - 70) / ((55 * 293.15) / 305.75));             // 0.533 ppm
});
check("ADC failure and time fallback", () => {
  assert.strictEqual(a.parseFirebaseRecord({ ...RECORD, adcOk: false }).vocMv, null);
  const noStamp = { ...RECORD }; delete noStamp.timestampUtc; delete noStamp.rtcUtc; delete noStamp.ntpUtc;
  assert.strictEqual(a.parseFirebaseRecord(noStamp).time.toISOString(), "2026-11-03T09:59:10.000Z");
});

// Averaging
check("10-min average, 4 of 5 = 11.5", () => near(a.windowAverage([10, 12, null, 11, 13]), 11.5));
check("10-min average, 3 of 5 = invalid", () => assert.strictEqual(a.windowAverage([10, null, null, 11, 13]), null));
check("completeness 75 %", () => {
  assert.ok(a.isComplete([1, 1, 1, null], 4));
  assert.ok(!a.isComplete([1, 1, null, null], 4));
});
check("wind vector average 0 / 90 / 285", () => {
  near(a.windDirectionAverage([350, 10]), 0);
  near(a.windDirectionAverage([80, 100]), 90);
  near(a.windDirectionAverage([270, 300]), 285);
});

// Alarms
const T = a.thresholds(5, 2, 8);
const runWindows = (tracker, values) => values.flatMap((v, i) => tracker.addWindow(at(10 * i), v)).map((e) => [e.event, e.level]);
check("thresholds 9 / 11 / 13", () => assert.deepStrictEqual(T, { Warning: 9, Action: 11, Critical: 13 }));
check("rapid rise example", () => {
  assert.ok(a.rapidRise([4, 6, 5], 12, 9));
  assert.ok(!a.rapidRise([4, 6, 5], 9.5, 9));
});
check("warning needs two in a row", () => {
  const t = new a.AlarmTracker("S1", "H2S", T);
  assert.deepStrictEqual(runWindows(t, [10]), []);
  assert.deepStrictEqual(runWindows(t, [10]), [["Raised", "Warning"]]);
});
check("invalid window does not break the row", () => {
  assert.deepStrictEqual(runWindows(new a.AlarmTracker("S1", "H2S", T), [10, null, 10]), [["Raised", "Warning"]]);
});
check("critical on one window", () => {
  assert.deepStrictEqual(runWindows(new a.AlarmTracker("S1", "H2S", T), [14]), [["Raised", "Critical"]]);
});
check("escalates instead of a second alarm", () => {
  assert.deepStrictEqual(runWindows(new a.AlarmTracker("S1", "H2S", T), [10, 10, 14]), [["Raised", "Warning"], ["Escalated", "Critical"]]);
});
check("warning clears after three below, closes on acknowledgement", () => {
  const t = new a.AlarmTracker("S1", "H2S", T);
  const events = runWindows(t, [10, 10, 5, 5, 5]);
  assert.deepStrictEqual(events[events.length - 1], ["Cleared", "Warning"]);
  assert.strictEqual(t.level, null);
  assert.deepStrictEqual(t.acknowledge(at(120), "dm.operator").map((e) => e.event), ["Acknowledged", "Closed"]);
});
check("action needs acknowledgement to clear", () => {
  const t = new a.AlarmTracker("S1", "H2S", T);
  runWindows(t, [12, 12, 5, 5, 5]);
  assert.strictEqual(t.level, "Action");
  t.acknowledge(at(60), "dm.operator");
  assert.deepStrictEqual(t.addWindow(at(120), 5).map((e) => e.event), ["Cleared", "Closed"]);
});
check("rapid rise raises Action", () => {
  assert.deepStrictEqual(runWindows(new a.AlarmTracker("S1", "H2S", T), [4, 6, 5, 12]), [["Raised", "Action"]]);
});

// Technical alarms
check("communication lost after 30 minutes", () => {
  assert.ok(!a.communicationLost(T0, at(30)));
  assert.ok(a.communicationLost(T0, at(31)));
});
check("flat line over 60 minutes", () => {
  const same = Array.from({ length: 32 }, (_, i) => ({ time: at(2 * i), value: 7 })); // 62 minutes
  assert.ok(a.flatLine(same));
  assert.ok(!a.flatLine(same.slice(0, 30)));                                         // 58 minutes
});

console.log(`\n${passed} checks passed${process.exitCode ? ", some FAILED" : ""}`);
