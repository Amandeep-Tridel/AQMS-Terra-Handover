# AQMS handover package for the Terra team

**Start here:** [`01_Handover_Note/AQMS_Handover_Note.pdf`](01_Handover_Note/AQMS_Handover_Note.pdf). It explains, in plain words, how to set up the stations, calibrate the sensors, and build the alarms and events in Terra. Terra does all the maths on the server.

A live, commentable version of the same note is at https://claude.ai/artifact/KLVnWHofbSay55D5d8PGJa (ask Amandeep for access).

## Calibration: Alphasense method only

Every gas value uses a zero and a sensitivity, by Alphasense's method only (AAN 803-05, and Alphasense's own advice of November 2026):

- **Sensitivity:** always from the sensor's factory calibration sheet.
- **Zero:** a **site zero**, the station's own output in clean air, taken from the cleanest part of the day (02:00–05:00 Dubai time, five nights). The factory zeros were measured by Alphasense in scrubbed, dry air at 20–25 °C; on our station they read about 1.4 ppm NH3 and 38 ppb H2S in clean air.

No filtering or smoothing.

```
H2S (ppb) = ((WE - WE zero) - (AE - AE zero)) / sensitivity
NH3 (ppm) = (WE - WE zero) / sensitivity
VOC (ppm) = (V - V zero) / sensitivity

H2S-B4, site zero:               H2S = ((A1 - 458) - (A2 - 359)) / 1.727952 ppb
NH3-B1+ 77840031, site zero:     NH3 = (A0 - 420) / 58.624 ppm
PIDX-A-040 datasheet typical:    VOC = (A3 - 70) / 55 ppm   (below 40 mV = fault)
```

- The factory-sheet zeros (H2S 395 / 362 mV, NH3 328 mV) are kept as older records.
- Replace the VOC values with the PID factory sheet when it arrives.
- A negative result always counts as 0, and every average uses those values.
- A channel at 2550 mV or more, or 5 mV or less, is stuck: **sensor fault**, no number.

## Temperature correction

Built in:

- **Sensitivity** at the sensor's temperature, all three sensors (datasheet charts; the PIDX-A-040 follows the ideal gas law, about 6 % low at 40 °C).
- **H2S zero** (AAN 803-05 Algorithms 1–4, Table 3), which also needs the ISB electronic offsets; k''T is in nA, so Algorithm 4 also needs the board gain.

The station does not send its sensor temperature yet. Until it does, the **Open-Meteo hourly air temperature at the Tridel Dubai office** (QD01, DAFZA Industrial Park, Al Qusais; Open-Meteo grid point 25.318 N, 55.394 E) stands in for it, for the sensitivity correction only. The station history and `run_sample` both use it. Switch to the sensor's own temperature as soon as the stations send it.

No pressure correction is needed (Dubai is at sea level). Alphasense has no humidity algorithm.

## What is in this repository

### `01_Handover_Note`
- `AQMS_Handover_Note.pdf`: the handover note.

### `02_Dubai_Municipality_requirements`
- `AQMS_Monitoring_Criteria_TEMS_Alarm_Configuration.pdf`: alarm levels, averaging and data-validity rules. Where the two DM documents disagree, follow this one.
- `AQMS_Functional_Specification.docx`: screens, user roles, calibration record, complaint investigation.

### `03_Alphasense_formulas_and_datasheets`
- `Alphasense_AAN-803-05.pdf`: electrochemical sensors (H2S, NH3): formulas, site zero, temperature algorithms (Tables 1–3).
- `Alphasense_AAN-302-04.pdf`: PID interfacing note (for the older PID-A1/AH): zero rule, error levels. Its temperature note does not apply to the PIDX-A-040: use the PIDX datasheet's Fig. 2.
- Datasheets for H2S-B4, NH3-B1 and PIDX-A-040.

### `04_Templates_and_test_values`
- `AQMS_Formulas_and_Templates.xlsx`: every formula as a live Excel sheet (yellow = inputs, green = answers), including the site zero, the AAN 803-05 temperature calculator, and the "Station record" sheet (every field of the record the station sends, and one real record worked through to gas values). Also empty templates: calibration record, threshold record, complaint event.
- `Live_station_data_2026-11-02.csv`: 300 live readings from the test station, 2 Nov 2026, 07:40 to 12:47 UTC (raw voltages only; `run_sample` turns them into gas values).
- `Sample_station_data_test_unit.csv`: 560 older readings from 28 Oct 2026, gas columns recalculated the same way as the history (site zeros, Open-Meteo temperature).
- `Station_history_readings.csv`: the station's complete history, 28 Oct to 3 Nov 2026 (7,350 readings), recalculated with the records in force (site zeros for H2S and NH3, datasheet typical for VOC) and each sensitivity corrected to the Open-Meteo hourly temperature at the Tridel Dubai office. 3 Nov 06:47–12:41 UTC: H2S sensor fault.
- `Station_history_10min_averages.csv`: the same history as 10-minute averages (756 windows).
- `Station_record_example_schema4.json`: one real record exactly as the test station sends it today (schema 4, 3 Nov 2026 09:59:10 UTC; its H2S channels are stuck, so it also shows the sensor-fault rule). Explained field by field in the note, section 4a.
- `Open_Meteo_hourly_temperature_Tridel_office.csv`: the hourly air temperature used.

### `05_Reference_Code`
Complete code in Python **and** JavaScript, doing exactly what the note says, **one file per language, ready to copy and paste**, with plain-words comments on every step: [`python/aqms_reference.py`](05_Reference_Code/python/aqms_reference.py) and [`javascript/aqms_reference.js`](05_Reference_Code/javascript/aqms_reference.js). Same 47 checks in both; identical results on the same data. See [`05_Reference_Code/README.md`](05_Reference_Code/README.md).

```
cd 05_Reference_Code/python
python -m unittest discover -s tests       # 47 checks
python run_sample.py                       # saved live data   (--live, --no-temperature)

cd ../javascript
npm test                                   # 47 checks
npm run sample                             # saved live data   (npm run live)
```

All example numbers in the note and the Excel sheet are made up to show the steps, except the real sensor examples (NH3 77840031, the H2S-B4 factory sheet and the site zeros), which are real.
