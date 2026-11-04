# AQMS reference code for the Terra team

Complete reference code in **Python** and **JavaScript**, **one file per language, ready to copy and paste**:

- `python/aqms_reference.py` (Python 3.9+, nothing to install)
- `javascript/aqms_reference.js` (Node 18+ or a browser, nothing to install)

Each file holds everything: the gas recipes, the temperature correction, the calibration records, reading the station's record, the averages and the alarms. Every step has a comment in plain words saying what it does and why, with a worked example. The two files are the same code line for line, pass the same 47 checks, and give byte-identical results on the same data, so the Terra team can use either one, or copy the logic into any other language.

Inside, each file is in five parts, in the same order as the handover note:

1. Turning voltages into gas (the three Alphasense recipes)
2. Temperature correction
3. Calibration records: which numbers to use for which reading
4. Reading what the station sends
5. Averages, alarms and equipment (technical) alarms

This replaces the earlier `airwatch-dubai` engine. That code wrapped the formulas in extra layers: Hampel spike filter, Kalman smoothing, noise models, gas-density correction, home-made temperature tables, NH3 cross-sensitivity and lag matching. **None of that is here.** The only temperature handling is Alphasense's own (below).

## Alphasense method only

Each gas value is worked out from the sensor's voltage, a zero and a sensitivity, using Alphasense's method only:

- **Sensitivity:** always from the sensor's own **factory calibration sheet** (or the datasheet typical value until that sheet exists).
- **Zero:** a **site zero** (`source: "site_zero"`): the station's own output in clean air, measured as AAN 803-05 "Initial calibration" describes and as Alphasense advised in November 2026, from the cleanest part of the day. The factory-sheet zeros (`source: "factory"`) are kept for history. Alphasense measures its factory zeros in filtered, scrubbed, dry air at 20–25 °C on its own boards; on our station, in real air and warmer, the same sensors sit higher, so the factory zeros read about 1.4 ppm NH3 and 38 ppb H2S in clean air.

```
H2S (ppb) = ((WE - WE zero) - (AE - AE zero)) / sensitivity      H2S-B4 on ISB, sheet gives WE zero, AE zero, sensitivity
NH3 (ppm) = (WE - WE zero) / sensitivity                          NH3-B1 on ISB, sheet gives WE zero, sensitivity
VOC (ppm) = (V - V zero)   / sensitivity                          PIDX-A-040,    sheet gives zero, sensitivity
```

All voltages are in mV. The H2S line is Alphasense AAN 803-05 Algorithm 3 at 20 °C, where its factor k'T is 1. The NH3 line is AAN 803-05 Algorithm 4 with no AE and k''T = 0 (the NH3-B1 has 3 electrodes, so the AE is simply left out, as Alphasense advised). The VOC line is the PIDX-A-040 datasheet's (zero and sensitivity). No pressure correction is needed (Alphasense: calibrate at the working pressure; Dubai is at sea level).

| Sensor | Record in use | Zero | Sensitivity |
| --- | --- | --- | --- |
| H2S-B4 | CAL-H2S-SITE-0001 (site zero) | WE 458 mV, AE 359 mV (factory sheet: 395 / 362) | 1.727952 mV/ppb, factory sheet |
| NH3-B1+ | CAL-NH3-SITE-0001 (site zero) | 420 mV (factory sheet 77840031: 328) | 58.624 mV/ppm = 73.28 nA/ppm × 0.8 mV/nA, factory sheet |
| PIDX-A-040 | CAL-VOC-DS-0001 (datasheet typical) | 70 mV (middle of 40–100 mV); below 40 mV = fault | 55 mV/ppm, datasheet |

The site zeros are the median output from 02:00 to 05:00 Dubai time on five nights (29 Oct – 3 Nov 2026, 899 readings). The older records (CAL-NH3-0001, CAL-H2S-0002, CAL-H2S-DS-0001) stay in the file for history and still apply to any reading before 28 Oct 2026.

**Repeat the site zero** when a sensor or board is changed or the station moves, and preferably before deployment in scrubbed, dry zero air. Add it as a new record with a later `valid_from`. Then, as Alphasense and AAN 803-05 both advise, put the station within about 1 m of a DM reference station for at least a week and fit an offset and a gain correction per gas.

### A channel stuck at the rail is a fault

A voltage at 2550 mV or more (the ADC tops out at 2560 mV) or at 5 mV or less means the channel is unplugged, unpowered or shorted. The reading gets no number and the reason `sensor fault (channel stuck at rail)`. For H2S, either A1 or A2 stuck is enough. This happened on 3 Nov 2026 from 06:47 UTC: A1 and A2 both sat at 2560 mV and, because they cancel in the formula, the old code showed 0 ppb.

### Temperature correction: built in, needs the sensor temperature

Pass the temperature at the **top of the sensor** (±1 °C) as `sensor_temp_c` / `sensorTempC` (one number, or one per gas). Without it nothing changes; at 20 °C nothing changes either. The station does not send it yet (the H2S-B4+ and NH3-B1+ have a temperature sensor on their IST board).

**Until it does, the Open-Meteo hourly air temperature at the Tridel Dubai office stands in for it** (QD01, DAFZA Industrial Park, Al Qusais Industrial Area 5, 25.28934 N 55.40345 E; Open-Meteo answers from its grid point 25.318 N 55.394 E, 3.4 km away). The live website, the station history in `04_Templates_and_test_values` and `run_sample` all do this; the hourly values are in `04_Templates_and_test_values/Open_Meteo_hourly_temperature_Tridel_office.csv`. Outdoor air can be several degrees from the sensor's own temperature, and it corrects only the sensitivity (the H2S zero correction needs the ISB electronic offsets), so switch to the sensor's own temperature as soon as the stations send it.

**1. Sensitivity, all three sensors** (AAN 803-05 step 5: divide by the sensitivity at that temperature):

```
sensitivity(T) = sensitivity(20 °C) × S(T) / 100
```

| °C | −30 | −20 | −10 | 0 | 10 | 20 | 30 | 40 | 50 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H2S-B4 S(T) %, datasheet Fig. 1 | 77 | 82 | 87 | 92 | 96 | 100 | 103 | 105.5 | 105.5 |
| NH3-B1 S(T) %, datasheet Fig. 2 | 116 | 112 | 104 | 100 | 98.5 | 100 | 103 | 110 | 125 |

These are read off the datasheet charts (middle of the typical batch), so they are approximate; replace them with Alphasense's own numbers if they send them. The **PIDX-A-040** datasheet (Fig. 2) says its output follows the ideal gas law, so S(T) = 100 × 293.15 / (273.15 + T): it reads about 6 % low at 40 °C. (AAN 302-04's "temperature correction can be ignored" is about the older PID-A1/PID-AH, not this PID.)

**2. Zero, H2S-B4 only** (AAN 803-05 Algorithms 1–4, Table 1, with the H2S-B4 factors of Table 3, linearly interpolated). It matters in Dubai: Algorithm 3's k'T is +1 at 20 °C but −1.2 at 30 °C and above. **k''T (Algorithm 4) is a current in nA** (it matches the datasheet's zero-shift chart: −65 / −125 / −180 nA at 30 / 40 / 50 °C), so it is multiplied by the board gain: k''T (mV) = k''T (nA) × `gain_mv_per_na`. The zero correction is used only when the record also has:

1. the board's electronic offsets `we_electronic_mv` and `ae_electronic_mv` (ISB sheet "Electronic Zero WE / AUX");
2. `temp_algorithm` (AAN 803-05 Table 2 suggests 1 for B-type H2S; choose by comparing with a reference station);
3. for Algorithm 4 only, `gain_mv_per_na` (ISB sheet).

Table 3 has no NH3-B1 row and the NH3-B1 datasheet gives no zero-vs-temperature data, so the NH3 zero is not corrected. Alphasense has no humidity algorithm. Each result says `temperature_corrected`, `zero_corrected` and `sensitivity_pct` (`temperatureCorrected`, `zeroCorrected`, `sensitivityPct` in JavaScript).

The VOC datasheet typical values can leave a steady offset in clean air (about ±0.55 ppm). When the PID factory sheet arrives, fill its block in `calibration/calibration_template_to_fill.json` and add it to `calibration_records.json` with a later `valid_from`: it takes over from that moment and the old record stays for history. The code refuses to load a record with any value missing.

## What is in it

```
calibration/
  calibration_records.json          all records: site zeros in use, factory and datasheet records kept
  calibration_template_to_fill.json VOC block, waiting for the PID factory sheet
python/                             Python 3.9+, no extra libraries
  aqms_reference.py                 THE CODE: everything in one file, with plain-words comments
  run_sample.py                     runs everything on real data (with the Open-Meteo temperature), writes two CSV files
  tests/test_reference.py           47 checks
javascript/                         Node 18+ or a browser, no dependencies
  aqms_reference.js                 THE CODE: the same as aqms_reference.py, line for line
  run_sample.js                     same as python/run_sample.py
  test/test_reference.js            the same 47 checks
  package.json                      npm test / npm run sample / npm run live
```

In a browser, add `<script src="aqms_reference.js"></script>`: everything is then on `window.AQMS`. `loadRecords` reads a file, so in a browser fetch `calibration_records.json` yourself and pass it to `recordsFromJson`.

Function names match across languages: `h2s_ppb` ↔ `h2sPpb`, `convert_reading` ↔ `convertReading`, `AlarmTracker.add_window` ↔ `AlarmTracker.addWindow`, and so on.

## Run it

```
cd python
python -m unittest discover -s tests -v      # 47 checks
python run_sample.py                         # saved live data, 2 Nov 2026
python run_sample.py --live                  # latest records from the live database (and Open-Meteo)
python run_sample.py --no-temperature        # the 20 °C formulas, no temperature correction

cd ../javascript
npm test                                     # 47 checks  (or: node test/test_reference.js)
npm run sample                               # saved live data
npm run live                                 # latest records from the live database (and Open-Meteo)
```

Each run writes `output_readings.csv` (every reading with the Open-Meteo temperature, the gas values, the reason when invalid and the sensitivity % used) and `output_10min_averages.csv`. The Python and JavaScript files come out byte for byte the same.

Using it from Terra (JavaScript):

```js
const aqms = require("./javascript");
const records = aqms.loadRecords("calibration/calibration_records.json");
const p = aqms.parsePacket("2026-11-02,12:47:23,0.34969,0.43008,0.36375,0.10063,NA");
const gas = aqms.convertReading(records, "aqms-monitor", p.time, { ...p, sensorTempC: 32.1 }); // Open-Meteo, 12:00 UTC
// gas.NH3 -> { value: 0, unit: "ppm", valid: true, source: "site_zero", recordId: "CAL-NH3-SITE-0001", sensitivityPct: 104.47, ... }
// gas.H2S -> { value: 0, unit: "ppb", valid: true, source: "site_zero", recordId: "CAL-H2S-SITE-0001", sensitivityPct: 103.53, ... }
// gas.VOC -> { value: 0.580, unit: "ppm", valid: true, source: "datasheet", recordId: "CAL-VOC-DS-0001", sensitivityPct: 96.04, ... }

const stuck = aqms.parsePacket("2026-11-03,12:00:52,0.38898,2.56086,2.56078,0.09797,NA");
aqms.convertReading(records, "aqms-monitor", stuck.time, stuck).H2S
// -> { value: null, valid: false, reason: "sensor fault (channel stuck at rail)", ... }
```

## Good to know

- **The station record** (schema 4, one about every minute; example: `04_Templates_and_test_values/Station_record_example_schema4.json`) is read by `parse_firebase_record` / `parseFirebaseRecord`. Time: `timestampUtc`, else `rtcUtc`, else `ntpUtc`, else the start of `combinedString`. Voltages: `volts` (× 1000 = mV), else `raw` converter steps (× 2560 / 32768), else `combinedString`. `adcOk: false` means no usable voltages. `batteryV`, `sampleAgeMs` and `schemaVersion` are passed on for the technical alarms; `a0Volts`, `h2sDiffV`, `averageCount`, `destination` and `stm32` are not used in any formula. Channels: A0 = NH3 WE, A1 = H2S WE, A2 = H2S AE, A3 = VOC.
- **The packet line** on its own (`combinedString`, `date,time,A0,A1,A2,A3,NA` in volts) is read by `parse_packet` / `parsePacket`, and so is the older `A0:raw=…|volts=…` style. "NA" or a missing channel stays missing.
- **A negative result counts as 0**, in every reading and therefore in every average. The raw voltages are stored unchanged, so nothing is lost. Results are never filled in or smoothed.
- **The test station sends one reading a minute**, not every 2 minutes. The example scripts therefore need 8 of 10 valid readings for a 10-minute window, the same 80 % as 4 of 5.
- **Alarm rules** follow DM's Monitoring Criteria. Start: 2 valid windows in a row, or one 30-minute average; Critical needs 1. Rapid rise starts Action. Clear: 3 valid windows below Warning, and Action and Critical also need an acknowledgement. An invalid window is skipped.
