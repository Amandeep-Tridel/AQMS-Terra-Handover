"""Checks the reference code against the worked examples in the handover note and
AQMS_Formulas_and_Templates.xlsx. Your Terra code should pass the same checks.
The JavaScript tests (../javascript/test_aqms_reference.js) check the same things.

Run from the python/ folder:   python -m unittest discover -s tests -v
"""

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import aqms_reference as af                                                # noqa: E402
from aqms_reference import (AlarmTracker, CalibrationRecord, communication_lost, convert_reading,  # noqa: E402
                            flat_line, is_complete, load_records, parse_firebase_record, parse_packet,
                            rapid_rise, record_in_force, thresholds, wind_direction_average, window_average)

CAL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "calibration")
T0 = datetime(2026, 11, 1, tzinfo=timezone.utc)
BEFORE_SITE_ZERO = datetime(2026, 10, 15, tzinfo=timezone.utc)   # only the factory-zero records apply


class Formulas(unittest.TestCase):
    def test_h2s_worked_example(self):
        # ((300 - 250) - (280 - 260)) / 0.4 = 75 ppb
        self.assertAlmostEqual(af.h2s_ppb(300, 250, 280, 260, 0.4), 75.0)

    def test_nh3_worked_example(self):
        # (320 - 270) / 5 = 10 ppm
        self.assertAlmostEqual(af.nh3_ppm(320, 270, 5), 10.0)

    def test_nh3_factory_sheet_77840031(self):
        self.assertAlmostEqual(af.nh3_ppm(349.69, 328, 58.624), (349.69 - 328) / 58.624)

    def test_voc_worked_example(self):
        self.assertAlmostEqual(af.voc_ppm(150, 40, 55), 2.0)
        self.assertFalse(af.voc_sensor_fault(150, 40))
        self.assertTrue(af.voc_sensor_fault(30, 40))

    def test_counts_to_mv_matches_station_volts(self):
        # The test station reports A0 raw=6246 as 0.48797 V.
        self.assertAlmostEqual(af.counts_to_mv(6246), 487.97, places=2)


class Calibration(unittest.TestCase):
    def test_latest_record_not_after_reading_time(self):
        old = CalibrationRecord("S1", "VOC", T0, 40, 55, record_id="old")
        new = CalibrationRecord("S1", "VOC", T0 + timedelta(days=10), 45, 50, record_id="new")
        recs = [old, new]
        self.assertEqual(record_in_force(recs, "S1", "VOC", T0 + timedelta(days=5)).record_id, "old")
        self.assertEqual(record_in_force(recs, "S1", "VOC", T0 + timedelta(days=10)).record_id, "new")
        self.assertIsNone(record_in_force(recs, "S1", "VOC", T0 - timedelta(days=1)))

    def test_no_record_means_no_number(self):
        r = convert_reading([], "S1", T0, voc_mv=150)["VOC"]
        self.assertIsNone(r.value)
        self.assertEqual(r.reason, "calibration missing")

    def test_site_zero_in_force_with_factory_sensitivity(self):
        recs = load_records(os.path.join(CAL_DIR, "calibration_records.json"))
        in_force = {g: record_in_force(recs, "aqms-monitor", g, T0) for g in ("H2S", "NH3", "VOC")}
        self.assertEqual({g: r.source for g, r in in_force.items()}, {"H2S": "site_zero", "NH3": "site_zero", "VOC": "datasheet"})
        out = convert_reading(recs, "aqms-monitor", T0, h2s_we_mv=500, h2s_ae_mv=360, nh3_we_mv=449.31, voc_mv=100)
        self.assertAlmostEqual(out["NH3"].value, (449.31 - 420) / 58.624)                  # site zero, sheet sensitivity
        self.assertEqual((out["NH3"].record_id, out["NH3"].source), ("CAL-NH3-SITE-0001", "site_zero"))
        self.assertAlmostEqual(out["H2S"].value, ((500 - 458) - (360 - 359)) / 1.727952)   # site zeros, sheet sensitivity
        self.assertEqual((out["H2S"].record_id, out["H2S"].source), ("CAL-H2S-SITE-0001", "site_zero"))
        self.assertAlmostEqual(out["VOC"].value, (100 - 70) / 55)                          # PIDX datasheet

    def test_factory_records_kept_for_earlier_readings(self):
        recs = load_records(os.path.join(CAL_DIR, "calibration_records.json"))
        out = convert_reading(recs, "aqms-monitor", BEFORE_SITE_ZERO, h2s_we_mv=430, h2s_ae_mv=364, nh3_we_mv=349.69)
        self.assertEqual((out["NH3"].record_id, out["H2S"].record_id), ("CAL-NH3-0001", "CAL-H2S-0002"))
        self.assertAlmostEqual(out["NH3"].value, (349.69 - 328) / 58.624)
        self.assertAlmostEqual(out["H2S"].value, ((430 - 395) - (364 - 362)) / 1.727952)

    def test_site_zero_reads_zero_in_the_clean_hours(self):
        recs = load_records(os.path.join(CAL_DIR, "calibration_records.json"))
        out = convert_reading(recs, "aqms-monitor", T0, h2s_we_mv=458.05, h2s_ae_mv=359.06, nh3_we_mv=420.08)
        self.assertLess(out["NH3"].value, 0.01)    # the factory zero would give 1.57 ppm here
        self.assertLess(out["H2S"].value, 1)       # the factory zero would give 38 ppb here

    def test_h2s_factory_sheet_worked_example(self):
        recs = load_records(os.path.join(CAL_DIR, "calibration_records.json"))
        ppb = convert_reading(recs, "aqms-monitor", BEFORE_SITE_ZERO, h2s_we_mv=600, h2s_ae_mv=300)["H2S"].value
        self.assertAlmostEqual(ppb / 1000, 267 / 1727.952)            # 0.1545 ppm, as on the sheet
        self.assertAlmostEqual(ppb / 1000, 0.1545, places=4)

    def test_negative_result_counts_as_zero(self):
        recs = load_records(os.path.join(CAL_DIR, "calibration_records.json"))
        out = convert_reading(recs, "aqms-monitor", T0, h2s_we_mv=347.81, h2s_ae_mv=401.25, nh3_we_mv=300, voc_mv=55)
        self.assertEqual((out["H2S"].value, out["NH3"].value, out["VOC"].value), (0.0, 0.0, 0.0))
        self.assertTrue(out["NH3"].valid)
        self.assertAlmostEqual(window_average([0.0, 0.0, 3.0, 1.0]), 1.0)   # averages use the floored values

    def test_voc_fault_only_below_datasheet_minimum(self):
        recs = load_records(os.path.join(CAL_DIR, "calibration_records.json"))
        self.assertTrue(convert_reading(recs, "aqms-monitor", T0, voc_mv=55)["VOC"].valid)   # below zero, above 40
        self.assertEqual(convert_reading(recs, "aqms-monitor", T0, voc_mv=35)["VOC"].reason, "sensor fault (below zero)")

    def test_channel_stuck_at_rail_is_a_fault(self):
        recs = load_records(os.path.join(CAL_DIR, "calibration_records.json"))
        # 3 Nov 2026: A1 and A2 stuck at full scale from 06:47 UTC; A0 at 2.19 mV at 06:47 UTC
        out = convert_reading(recs, "aqms-monitor", T0, h2s_we_mv=2560.86, h2s_ae_mv=2560.78, nh3_we_mv=2.19, voc_mv=97.97)
        for gas in ("H2S", "NH3"):
            self.assertIsNone(out[gas].value)
            self.assertEqual(out[gas].reason, "sensor fault (channel stuck at rail)")
        self.assertTrue(out["VOC"].valid)
        self.assertIsNone(convert_reading(recs, "aqms-monitor", T0, h2s_we_mv=450, h2s_ae_mv=2555)["H2S"].value)

    def test_template_cannot_be_loaded_until_filled(self):
        with self.assertRaises(ValueError):
            load_records(os.path.join(CAL_DIR, "calibration_template_to_fill.json"))

    def test_filled_h2s_record_works(self):
        rec = {"record_id": "X", "station_id": "S1", "channel": "H2S", "valid_from": "2026-10-01T00:00:00Z",
               "we_zero_mv": 250, "ae_zero_mv": 260, "sensitivity": 0.4}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump({"records": [rec]}, f)
        try:
            recs = load_records(f.name)
        finally:
            os.remove(f.name)
        r = convert_reading(recs, "S1", T0, h2s_we_mv=300, h2s_ae_mv=280)["H2S"]
        self.assertAlmostEqual(r.value, 75.0)


class TemperatureCorrection(unittest.TestCase):
    """AAN 803-05 Tables 1 and 3 (zero, H2S) and the datasheet sensitivity curves (all three).
    Nothing changes without a sensor temperature, and nothing changes at 20 degC."""

    def test_table3_interpolation(self):
        k3 = af.H2S_B4_FACTORS[3]
        self.assertEqual(af.table3_factor(k3, 20), 1)
        self.assertAlmostEqual(af.table3_factor(k3, 25), -0.1)               # halfway between 1 and -1.2
        self.assertEqual(af.table3_factor(k3, 45), -1.2)
        self.assertEqual(af.table3_factor(af.H2S_B4_FACTORS[4], 60), -180)   # outside the table: end value

    def test_k2t_is_nA_and_needs_the_board_gain(self):
        self.assertAlmostEqual(af.aan803_factor(4, 30, gain_mv_per_na=0.8), -52.0)   # -65 nA x 0.8 mV/nA
        self.assertIsNone(af.aan803_factor(4, 30))
        self.assertAlmostEqual(af.aan803_factor(3, 35), -1.2)                         # no unit, no gain needed

    def test_sensitivity_curves(self):
        self.assertEqual(af.sensitivity_pct("H2S-B4", 20), 100)
        self.assertAlmostEqual(af.sensitivity_pct("H2S-B4", 35), 104.25)
        self.assertAlmostEqual(af.sensitivity_pct("NH3-B1+", 40), 110)
        self.assertAlmostEqual(af.sensitivity_pct("PIDX-A-040", 20), 100)
        self.assertAlmostEqual(af.sensitivity_pct("PIDX-A-040", 40), 100 * 293.15 / 313.15)   # ideal gas law
        self.assertIsNone(af.sensitivity_pct("unknown", 40))

    def test_algorithms_worked_example(self):
        # WEu 500, AEu 360, WEe 300, AEe 310, WEt 458, AEt 359  ->  WEo 158, AEo 49
        args = dict(we_u=500, we_e=300, we_t=458, ae_u=360, ae_e=310, ae_t=359)
        self.assertAlmostEqual(af.aan803_corrected_we(1, -2.5, **args), 200 + 2.5 * 50)
        self.assertAlmostEqual(af.aan803_corrected_we(2, 1, **args), 200 - (158 / 49) * 50)
        self.assertAlmostEqual(af.aan803_corrected_we(3, 1, **args), 200 - 109 - 50)
        self.assertAlmostEqual(af.aan803_corrected_we(4, 0, 500, 300, 458), 200 - 158)

    def test_algorithm3_at_20c_equals_the_plain_formula(self):
        plain = af.h2s_ppb(500, 458, 360, 359, 1.727952)
        we_c = af.aan803_corrected_we(3, af.aan803_factor(3, 20), 500, 300, 458, 360, 310, 359)
        self.assertAlmostEqual(we_c / 1.727952, plain)

    def test_no_temperature_changes_nothing(self):
        recs = load_records(os.path.join(CAL_DIR, "calibration_records.json"))
        out = convert_reading(recs, "aqms-monitor", T0, h2s_we_mv=500, h2s_ae_mv=360, nh3_we_mv=449.31, voc_mv=100)
        self.assertFalse(any(r.temperature_corrected for r in out.values()))
        self.assertEqual({r.sensitivity_pct for r in out.values()}, {100.0})

    def test_sensitivity_only_without_electronic_offsets(self):
        recs = load_records(os.path.join(CAL_DIR, "calibration_records.json"))
        out = convert_reading(recs, "aqms-monitor", T0, h2s_we_mv=500, h2s_ae_mv=360, nh3_we_mv=449.31, voc_mv=100,
                              sensor_temp_c=40)
        h2s = out["H2S"]
        self.assertTrue(h2s.temperature_corrected)
        self.assertFalse(h2s.zero_corrected)
        self.assertAlmostEqual(h2s.value, ((500 - 458) - (360 - 359)) / (1.727952 * 1.055))
        self.assertAlmostEqual(out["NH3"].value, (449.31 - 420) / (58.624 * 1.10))
        self.assertAlmostEqual(out["VOC"].value, (100 - 70) / 55 * 313.15 / 293.15)   # PID reads low when hot
        same = convert_reading(recs, "aqms-monitor", T0, h2s_we_mv=500, h2s_ae_mv=360, sensor_temp_c=20)["H2S"]
        self.assertAlmostEqual(same.value, ((500 - 458) - (360 - 359)) / 1.727952)

    def test_zero_and_sensitivity_with_electronic_offsets(self):
        rec = CalibrationRecord("S1", "H2S", T0, 458, 1.727952, ae_zero_mv=359, sensor_model="H2S-B4",
                                we_electronic_mv=300, ae_electronic_mv=310, temp_algorithm=3)
        r = convert_reading([rec], "S1", T0, h2s_we_mv=500, h2s_ae_mv=360, sensor_temp_c=35)["H2S"]
        self.assertTrue(r.zero_corrected)
        self.assertAlmostEqual(r.value, (200 - 109 + 1.2 * 50) / (1.727952 * 1.0425))   # k'T -1.2, sensitivity 104.25 %
        r20 = convert_reading([rec], "S1", T0, h2s_we_mv=500, h2s_ae_mv=360, sensor_temp_c=20)["H2S"]
        self.assertAlmostEqual(r20.value, ((500 - 458) - (360 - 359)) / 1.727952)
        self.assertFalse(convert_reading([rec], "S1", T0, h2s_we_mv=500, h2s_ae_mv=360)["H2S"].temperature_corrected)

    def test_algorithm4_needs_the_board_gain(self):
        base = dict(ae_zero_mv=359, sensor_model="H2S-B4", we_electronic_mv=300, ae_electronic_mv=310, temp_algorithm=4)
        no_gain = CalibrationRecord("S1", "H2S", T0, 458, 1.727952, **base)
        self.assertFalse(convert_reading([no_gain], "S1", T0, h2s_we_mv=500, h2s_ae_mv=360, sensor_temp_c=30)["H2S"].zero_corrected)
        with_gain = CalibrationRecord("S1", "H2S", T0, 458, 1.727952, gain_mv_per_na=0.8, **base)
        r = convert_reading([with_gain], "S1", T0, h2s_we_mv=500, h2s_ae_mv=360, sensor_temp_c=30)["H2S"]
        self.assertTrue(r.zero_corrected)
        self.assertAlmostEqual(r.value, (200 - 158 + 52) / (1.727952 * 1.03))   # k''T -65 nA x 0.8 = -52 mV


class Packets(unittest.TestCase):
    def test_current_live_packet_style(self):
        p = parse_packet("2026-11-02,12:47:23,0.34969,0.43008,0.36375,0.10063,NA")
        self.assertEqual(p["time"], datetime(2026, 11, 2, 12, 47, 23, tzinfo=timezone.utc))
        self.assertAlmostEqual(p["nh3_we_mv"], 349.69)
        self.assertAlmostEqual(p["h2s_we_mv"], 430.08)
        self.assertAlmostEqual(p["h2s_ae_mv"], 363.75)
        self.assertAlmostEqual(p["voc_mv"], 100.63)

    def test_older_packet_style(self):
        p = parse_packet("2026-10-28,14:16:00,A0:raw=6246|volts=0.48797,A1:raw=6013|volts=0.46977,"
                         "A2:raw=4622|volts=0.36109,A3:raw=1342|volts=0.10484,STM32:NA")
        self.assertAlmostEqual(p["h2s_ae_mv"], 361.09)

    def test_missing_channel_stays_missing(self):
        self.assertIsNone(parse_packet("2026-11-02,12:47:23,0.34969,NA,0.36375,0.10063,NA")["h2s_we_mv"])

    def test_live_firebase_record(self):
        rec = {"timestampUtc": "2026-11-02T12:47:23Z", "device": "aqms-monitor",
               "volts": [0.34969, 0.43008, 0.36375, 0.10063], "raw": [4476, 5505, 4656, 1288]}
        p = parse_firebase_record(rec)
        self.assertEqual(p["station_id"], "aqms-monitor")
        self.assertAlmostEqual(p["voc_mv"], 100.63)


class StationRecord(unittest.TestCase):
    """The full schema-4 record the station sends (04_Templates_and_test_values/Station_record_example_schema4.json)."""
    RECORD = json.loads('{"a0Volts":0.36734,"adcOk":true,"averageCount":1,"batteryV":11.7587,"combinedString":"2026-11-03,09:59:10,0.36734,2.55422,2.55391,0.09812,NA","destination":"client","device":"aqms-monitor","h2sDiffV":0.00031,"ntpUtc":"2026-11-03T09:59:11Z","raw":[4702,32694,32690,1256],"rtcUtc":"2026-11-03T09:59:10Z","sampleAgeMs":3419,"schemaVersion":4,"stm32":{"available":false,"echoIgnored":0,"fresh":false,"messageCount":0,"rejectedCount":0,"reset":{"ackCount":0,"ackKind":"none","cooldownRemainingMs":0,"remainingMs":0,"state":"idle","timeoutSeconds":30}},"timestampUtc":"2026-11-03T09:59:10Z","volts":[0.36734,2.55422,2.55391,0.09812]}')

    def test_record_fields(self):
        p = parse_firebase_record(self.RECORD)
        self.assertEqual(p["time"], datetime(2026, 11, 3, 9, 59, 10, tzinfo=timezone.utc))
        self.assertEqual((p["station_id"], p["adc_ok"], p["battery_v"], p["schema_version"]), ("aqms-monitor", True, 11.7587, 4))
        self.assertAlmostEqual(p["h2s_we_mv"], 2554.22)
        self.assertAlmostEqual(af.counts_to_mv(self.RECORD["raw"][1]), 2554.22, places=1)   # counts agree with volts
        self.assertAlmostEqual(p["h2s_we_mv"] - p["h2s_ae_mv"], self.RECORD["h2sDiffV"] * 1000)

    def test_record_through_the_formulas(self):
        recs = load_records(os.path.join(CAL_DIR, "calibration_records.json"))
        p = parse_firebase_record(self.RECORD)
        out = convert_reading(recs, "aqms-monitor", p["time"], h2s_we_mv=p["h2s_we_mv"], h2s_ae_mv=p["h2s_ae_mv"],
                              nh3_we_mv=p["nh3_we_mv"], voc_mv=p["voc_mv"], sensor_temp_c=32.6)   # Open-Meteo, 09:00 UTC
        self.assertEqual(out["H2S"].reason, "sensor fault (channel stuck at rail)")      # A1 2554.22 mV >= 2550
        self.assertEqual(out["NH3"].value, 0.0)                                           # 367.34 - 420 < 0 -> 0
        self.assertAlmostEqual(out["VOC"].value, (98.12 - 70) / (55 * 293.15 / 305.75))  # 0.533 ppm

    def test_adc_failure_and_time_fallback(self):
        bad = dict(self.RECORD, adcOk=False)
        self.assertIsNone(parse_firebase_record(bad)["voc_mv"])
        no_stamp = {k: v for k, v in self.RECORD.items() if k not in ("timestampUtc", "rtcUtc", "ntpUtc")}
        self.assertEqual(parse_firebase_record(no_stamp)["time"], datetime(2026, 11, 3, 9, 59, 10, tzinfo=timezone.utc))


class Averaging(unittest.TestCase):
    def test_four_of_five_valid(self):
        self.assertAlmostEqual(window_average([10, 12, None, 11, 13]), 11.5)

    def test_three_of_five_is_invalid(self):
        self.assertIsNone(window_average([10, None, None, 11, 13]))

    def test_completeness_75_percent(self):
        self.assertTrue(is_complete([1, 1, 1, None], 4))
        self.assertFalse(is_complete([1, 1, None, None], 4))

    def test_wind_vector_average(self):
        self.assertAlmostEqual(wind_direction_average([350, 10]), 0.0, places=6)
        self.assertAlmostEqual(wind_direction_average([80, 100]), 90.0, places=6)
        self.assertAlmostEqual(wind_direction_average([270, 300]), 285.0, places=6)


class Alarms(unittest.TestCase):
    T = thresholds(5, 2, 8)

    def test_thresholds_example(self):
        self.assertEqual(self.T, {"Warning": 9, "Action": 11, "Critical": 13})

    def test_rapid_rise_example(self):
        self.assertTrue(rapid_rise([4, 6, 5], 12, 9))
        self.assertFalse(rapid_rise([4, 6, 5], 9.5, 9))

    def run_windows(self, tracker, values):
        events = []
        for i, v in enumerate(values):
            events += tracker.add_window(T0 + timedelta(minutes=10 * i), v)
        return [(e[1], e[2]) for e in events]

    def test_warning_needs_two_in_a_row(self):
        a = AlarmTracker("S1", "H2S", self.T)
        self.assertEqual(self.run_windows(a, [10]), [])
        self.assertEqual(self.run_windows(a, [10]), [("Raised", "Warning")])

    def test_invalid_window_does_not_break_the_row(self):
        a = AlarmTracker("S1", "H2S", self.T)
        self.assertEqual(self.run_windows(a, [10, None, 10]), [("Raised", "Warning")])

    def test_critical_on_one_window(self):
        a = AlarmTracker("S1", "H2S", self.T)
        self.assertEqual(self.run_windows(a, [14]), [("Raised", "Critical")])

    def test_escalates_instead_of_second_alarm(self):
        a = AlarmTracker("S1", "H2S", self.T)
        self.assertEqual(self.run_windows(a, [10, 10, 14]), [("Raised", "Warning"), ("Escalated", "Critical")])

    def test_warning_clears_after_three_below_then_closes_on_ack(self):
        a = AlarmTracker("S1", "H2S", self.T)
        events = self.run_windows(a, [10, 10, 5, 5, 5])
        self.assertEqual(events[-1], ("Cleared", "Warning"))
        self.assertIsNone(a.level)
        self.assertEqual([e[1] for e in a.acknowledge(T0 + timedelta(hours=2), "dm.operator")],
                         ["Acknowledged", "Closed"])

    def test_action_needs_acknowledgement_to_clear(self):
        a = AlarmTracker("S1", "H2S", self.T)
        self.run_windows(a, [12, 12, 5, 5, 5])
        self.assertEqual(a.level, "Action")          # not cleared: nobody acknowledged
        a.acknowledge(T0 + timedelta(hours=1), "dm.operator")
        events = a.add_window(T0 + timedelta(hours=2), 5)
        self.assertEqual([e[1] for e in events], ["Cleared", "Closed"])

    def test_rapid_rise_raises_action(self):
        a = AlarmTracker("S1", "H2S", self.T)
        self.assertEqual(self.run_windows(a, [4, 6, 5, 12]), [("Raised", "Action")])


class TechnicalAlarms(unittest.TestCase):
    def test_communication_lost_after_30_minutes(self):
        self.assertFalse(communication_lost(T0, T0 + timedelta(minutes=30)))
        self.assertTrue(communication_lost(T0, T0 + timedelta(minutes=31)))

    def test_flat_line_over_60_minutes(self):
        same = [(T0 + timedelta(minutes=2 * i), 7.0) for i in range(32)]   # 62 minutes
        self.assertTrue(flat_line(same))
        self.assertFalse(flat_line(same[:30]))                              # 58 minutes


if __name__ == "__main__":
    unittest.main()
