"""Run the reference code on real test-station data, start to finish.

    python run_sample.py                         # the saved live data, 2 Nov 2026
    python run_sample.py --live                  # the latest records from the live database
    python run_sample.py --sample ../../04_Templates_and_test_values/Sample_station_data_test_unit.csv
    python run_sample.py --no-temperature        # the 20 degC formulas, no temperature correction

Each packet is converted with the calibration record in force, 10-minute
averages are made, and two CSV files are written next to this script.

NH3 and H2S use their site zero with the factory-sheet sensitivity; VOC uses datasheet
typical values (../calibration/calibration_records.json). A channel stuck at the ADC rail
is reported as a sensor fault, not as a number.
Temperature: the station sends no sensor temperature, so the Open-Meteo hourly air
temperature at the Tridel Dubai office stands in for it (saved data: the hourly file in
04_Templates_and_test_values; --live: fetched from Open-Meteo). It corrects only the
sensitivity of each gas; the H2S zero correction needs the ISB electronic offsets.
The test station sends about one reading per minute, so a 10-minute window expects
10 readings and needs 8 valid (the same 80 % as 4 of 5 for 2-minute data).
A negative result counts as 0, so the averages never go below 0.
"""

import argparse
import csv
import json
import os
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # find aqms_reference.py (next to this script) however it is started

from aqms_reference import (convert_reading, load_records, parse_firebase_record,  # noqa: E402
                            parse_packet, window_average)

# normpath removes the ".." steps, so the paths stay short (Windows limits a path to 260 characters).
DATA = os.path.normpath(os.path.join(HERE, "..", "..", "04_Templates_and_test_values"))
DEFAULT_SAMPLE = os.path.join(DATA, "Live_station_data_2026-11-02.csv")
HOURLY_TEMPERATURE = os.path.join(DATA, "Open_Meteo_hourly_temperature_Tridel_office.csv")
DEFAULT_CALIBRATION = os.path.normpath(os.path.join(HERE, "..", "calibration", "calibration_records.json"))
LIVE_URL = "https://aqms-65300-default-rtdb.firebaseio.com/data.json"
# Tridel Dubai office: QD01, DAFZA Industrial Park, Al Qusais Industrial Area 5 (Open-Meteo grid 25.318 N, 55.394 E)
OPEN_METEO_URL = ("https://api.open-meteo.com/v1/forecast?latitude=25.28934&longitude=55.40345"
                  "&hourly=temperature_2m&past_days=2&forecast_days=1&timezone=UTC")
GASES = ("H2S", "NH3", "VOC")


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        return [parse_packet(row["raw_string"]) for row in csv.DictReader(f)]


def read_live(count):
    query = urllib.parse.urlencode({"orderBy": '"$key"', "limitToLast": count})
    with urllib.request.urlopen(f"{LIVE_URL}?{query}", timeout=60) as resp:
        records = json.load(resp).values()
    return sorted((parse_firebase_record(r) for r in records), key=lambda p: p["time"])


def hourly_temperatures(live):
    """{"YYYY-MM-DDTHH": degC} from the saved hourly file, plus Open-Meteo itself for --live."""
    temps = {}
    if os.path.exists(HOURLY_TEMPERATURE):
        with open(HOURLY_TEMPERATURE, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if row["temperature_2m_c"]:
                    temps[row["hour_utc"][:13]] = float(row["temperature_2m_c"])
    else:
        print(f"warning: {HOURLY_TEMPERATURE} not found: saved readings get no temperature correction")
    if live:
        with urllib.request.urlopen(OPEN_METEO_URL, timeout=60) as resp:
            hourly = json.load(resp)["hourly"]
        temps.update({t[:13]: v for t, v in zip(hourly["time"], hourly["temperature_2m"]) if v is not None})
    return temps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", default=DEFAULT_SAMPLE)
    ap.add_argument("--live", action="store_true", help="read the latest records from the live database")
    ap.add_argument("--count", type=int, default=300, help="how many live records to read")
    ap.add_argument("--calibration", default=DEFAULT_CALIBRATION)
    ap.add_argument("--station", default="aqms-monitor")
    ap.add_argument("--no-temperature", action="store_true", help="do not use the Open-Meteo temperature")
    args = ap.parse_args()

    records = load_records(args.calibration)
    packets = read_live(args.count) if args.live else read_csv(args.sample)
    temps = {} if args.no_temperature else hourly_temperatures(args.live)
    readings_out = os.path.join(HERE, "output_readings.csv")
    averages_out = os.path.join(HERE, "output_10min_averages.csv")

    windows = defaultdict(lambda: {g: [] for g in GASES})
    rows = []
    for p in packets:
        temp_c = temps.get(p["time"].astimezone(timezone.utc).strftime("%Y-%m-%dT%H"))
        gas = convert_reading(
            records, args.station, p["time"],
            h2s_we_mv=p["h2s_we_mv"], h2s_ae_mv=p["h2s_ae_mv"],
            nh3_we_mv=p["nh3_we_mv"], voc_mv=p["voc_mv"], sensor_temp_c=temp_c,
        )
        start = p["time"].replace(minute=p["time"].minute // 10 * 10, second=0)
        for g in GASES:
            windows[start][g].append(gas[g].value)
        rows.append([_iso(p["time"]), _fmt(p["h2s_we_mv"], 2), _fmt(p["h2s_ae_mv"], 2),
                     _fmt(p["nh3_we_mv"], 2), _fmt(p["voc_mv"], 2), _fmt(temp_c, 1)]
                    + [x for g in GASES for x in (_fmt(gas[g].value), gas[g].reason)]
                    + [_fmt(gas[g].sensitivity_pct if gas[g].valid else None, 2) for g in GASES])

    with open(readings_out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["time_utc", "h2s_we_mv", "h2s_ae_mv", "nh3_we_mv", "voc_mv", "open_meteo_temp_c",
                    "h2s_ppb", "h2s_invalid_reason", "nh3_ppm", "nh3_invalid_reason",
                    "voc_ppm", "voc_invalid_reason",
                    "h2s_sensitivity_pct", "nh3_sensitivity_pct", "voc_sensitivity_pct"])
        w.writerows(rows)

    with open(averages_out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["window_start_utc", "readings", "h2s_ppb_10min", "nh3_ppm_10min", "voc_ppm_10min"])
        for start in sorted(windows):
            win = windows[start]
            w.writerow([_iso(start), len(win["NH3"])]
                       + [_fmt(window_average(win[g], minimum_valid=8)) for g in GASES])

    source = "live database" if args.live else os.path.basename(args.sample)
    with_temp = sum(1 for r in rows if r[5])
    print(f"{len(rows)} readings from {source} ({with_temp} with Open-Meteo temperature) -> {readings_out}")
    print(f"{len(windows)} ten-minute windows -> {averages_out}")


def _iso(t):
    """UTC time as 2026-11-02T07:40:22Z, the same text the JavaScript version writes."""
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _fmt(value, places=4):
    return "" if value is None else f"{value:.{places}f}"


if __name__ == "__main__":
    main()
