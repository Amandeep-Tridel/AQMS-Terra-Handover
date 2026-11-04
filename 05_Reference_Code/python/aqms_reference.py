"""
AQMS reference code for the Terra team, in ONE file you can copy and paste.
==========================================================================

What this file does, in plain words
-----------------------------------
A gas station on a pole sends us small voltages (millivolts, "mV") from three gas
sensors. This file turns those voltages into gas numbers, makes the 10-minute
averages, and decides when an alarm starts and stops. It does exactly what the
handover note says, using only Alphasense's own formulas (Alphasense makes the
sensors) and Dubai Municipality's (DM) rules. Nothing is smoothed, filtered or guessed.

How to use it
-------------
Copy this file into your project. It needs only Python 3.9 or newer, nothing else
(no pip install). Then, for example:

    import aqms_reference as aqms

    records = aqms.load_records("calibration_records.json")   # the calibration numbers
    reading = aqms.parse_firebase_record(record_from_station)  # the station's JSON record
    gas = aqms.convert_reading(records, "aqms-monitor", reading["time"],
                               h2s_we_mv=reading["h2s_we_mv"], h2s_ae_mv=reading["h2s_ae_mv"],
                               nh3_we_mv=reading["nh3_we_mv"], voc_mv=reading["voc_mv"],
                               sensor_temp_c=32.6)             # temperature, if you have one
    print(gas["H2S"].value, gas["NH3"].value, gas["VOC"].value)

The file is in five parts, in the same order as the handover note:
    PART 1  Turning voltages into gas (the three Alphasense recipes)
    PART 2  Temperature correction
    PART 3  Calibration records: which numbers to use for which reading
    PART 4  Reading what the station sends
    PART 5  Averages, alarms and equipment (technical) alarms

The JavaScript file aqms_reference.js is the same code, line for line, in JavaScript.
Both pass the same checks (tests/test_reference.py and test/test_reference.js).

A few words used everywhere below
---------------------------------
  mV           millivolt, the tiny electric signal a sensor gives out.
  WE           "working electrode": the part of a gas sensor that touches the gas.
  AE           "auxiliary electrode": a twin part that never touches the gas. It only
               feels heat, so taking it away removes most of the heat effect (H2S only).
  zero         what a sensor reads when there is NO gas. We always subtract it.
  sensitivity  how many mV the sensor gives for each ppb or ppm of gas.
  ppm / ppb    parts per million / parts per billion. 1 ppm = 1,000 ppb.
  None         Python's "no value". A reading with no valid number is None,
               never 0, so it is left out of averages instead of pulling them down.
"""

import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Optional


# =============================================================================
# PART 1  Turning voltages into gas (the three Alphasense recipes)
# =============================================================================
#
# Every recipe is the same idea: take the zero away, then divide by the sensitivity.
#
#     gas = (voltage now - zero voltage) / sensitivity
#
# Example: a sensor reads 320 mV, its zero is 270 mV and it gives 5 mV per ppm.
# 320 - 270 = 50 mV of real signal. 50 / 5 = 10 ppm of gas.

# The station's converter (ADC) measures 0 to 2.56 V in 32,768 equal steps.
# So one step is 2560 / 32768 = 0.078 mV.
ADC_FULL_SCALE_MV = 2560.0
ADC_STEPS = 32768

# A working sensor gives roughly 90 to 500 mV in clean air, and gas pushes it up
# smoothly. A voltage pressed against the very top (2560 mV) or the very bottom
# (0 mV) is not gas: it means a loose cable, no power, or a short circuit.
# 2550 leaves a 10 mV safety margin below the top.
RAIL_HIGH_MV = 2550.0
RAIL_LOW_MV = 5.0


def counts_to_mv(counts, full_scale_mv=ADC_FULL_SCALE_MV, steps=ADC_STEPS):
    """Turn a raw converter number ("counts" or "steps") into millivolts.

    Only needed when the station sends counts instead of volts.
    Example: 4702 counts x 2560 / 32768 = 367.34 mV.
    """
    return counts * full_scale_mv / steps


def channel_at_rail(mv):
    """True when the voltage is stuck at the top or the bottom of the range.

    "Stuck" means the sensor is not really being measured (unplugged, no power,
    shorted). Such a reading must get NO gas number. Example: on 3 Nov 2026 the
    H2S channels sat at 2554 mV for six hours: that is stuck, not gas.
    """
    return mv >= RAIL_HIGH_MV or mv <= RAIL_LOW_MV


def h2s_ppb(we_mv, we_zero_mv, ae_mv, ae_zero_mv, sensitivity_mv_per_ppb):
    """H2S (sensor H2S-B4, 4 electrodes), in ppb.

        H2S = ((WE - WE zero) - (AE - AE zero)) / sensitivity

    Step by step:
      1. WE signal = WE - WE zero       (what the gas side gives above its zero)
      2. AE signal = AE - AE zero       (what the heat alone did to the twin)
      3. corrected = WE signal - AE signal   (gas only, heat effect removed)
      4. H2S = corrected / sensitivity

    This is Alphasense's note AAN 803-05, Algorithm 3, at 20 degC.
    Example: ((300 - 250) - (280 - 260)) / 0.4 = (50 - 20) / 0.4 = 75 ppb.
    """
    we_signal = we_mv - we_zero_mv
    ae_signal = ae_mv - ae_zero_mv
    return (we_signal - ae_signal) / sensitivity_mv_per_ppb


def nh3_ppm(we_mv, we_zero_mv, sensitivity_mv_per_ppm):
    """NH3 (sensor NH3-B1, 3 electrodes), in ppm.

        NH3 = (WE - WE zero) / sensitivity

    The NH3 sensor has no AE twin, so there is nothing to take away for heat.
    Alphasense: "just leave the AE out". This is AAN 803-05 Algorithm 4 at 20 degC.
    Example on the test station: (449.31 - 420) / 58.624 = 0.50 ppm.
    """
    return (we_mv - we_zero_mv) / sensitivity_mv_per_ppm


def voc_ppm(v_mv, v_zero_mv, sensitivity_mv_per_ppm):
    """VOC (sensor PIDX-A-040, the "PID"), in ppm, as isobutylene.

        VOC = (V - V zero) / sensitivity

    Isobutylene is just the reference gas the PID is compared against.
    Example: (150 - 40) / 55 = 2 ppm.
    """
    return (v_mv - v_zero_mv) / sensitivity_mv_per_ppm


def voc_sensor_fault(v_mv, v_zero_mv):
    """A PID voltage BELOW its lowest normal value means a broken sensor, not clean air.

    The PID datasheet says a working PID never goes below 40 mV.
    """
    return v_mv < v_zero_mv


# =============================================================================
# PART 2  Temperature correction
# =============================================================================
#
# Heat changes two things in a gas sensor:
#   - its SENSITIVITY (how strongly it answers to gas), for all three sensors, and
#   - its ZERO (what it reads with no gas), handled here for H2S only.
#
# Both corrections need the temperature at the top of the sensor. The station does
# not measure that yet, so for now the Open-Meteo hourly air temperature at the
# station's location stands in for it, and only the SENSITIVITY part is used.
# At 20 degC nothing changes, because all the factory numbers are measured at 20 degC.

# The temperatures the tables below are given at, in degC.
TABLE3_TEMPS_C = (-30, -20, -10, 0, 10, 20, 30, 40, 50)

# Alphasense note AAN 803-05, Table 3, the H2S-B4 row, copied exactly.
# One row of factors for each of Alphasense's four zero-correction algorithms.
# nT, kT and k'T are plain numbers. k''T is a CURRENT in nA (it matches the H2S-B4
# datasheet's chart: -65, -125 and -180 nA at 30, 40 and 50 degC), so before it can
# be taken away from a voltage it must be multiplied by the board's gain (mV per nA).
H2S_B4_FACTORS = {
    1: (-0.6, -0.6, 0.1, 0.8, -0.7, -2.5, -2.5, -2.2, -1.8),   # nT
    2: (0.2, 0.2, 0, -0.3, 0.3, 1, 1, 0.9, 0.7),               # kT
    3: (-14, -14, 3, 3, 2, 1, -1.2, -1.2, -1.2),               # k'T
    4: (52, 51, 48, 45, 26, 0, -65, -125, -180),               # k''T (nA)
}
# AAN 803-05 Table 2 suggests Algorithm 1 for this sensor type. Table 3 has no NH3-B1
# row, and the NH3-B1 datasheet gives no zero-against-temperature data, so the NH3
# zero is never temperature-corrected.

# How sensitive each sensor is at each temperature, as % of its sensitivity at 20 degC.
# Read off the datasheet charts (the middle of the typical batch shown), so these are
# approximate. Replace them with Alphasense's own numbers if they send them.
# Example: at 30 degC the H2S sensor gives 103 % of its 20 degC signal for the same gas.
SENSITIVITY_PCT = {
    "H2S-B4": (77, 82, 87, 92, 96, 100, 103, 105.5, 105.5),     # H2S-B4 datasheet, Fig. 1
    "NH3-B1": (116, 112, 104, 100, 98.5, 100, 103, 110, 125),   # NH3-B1 datasheet, Fig. 2
}

# 20 degC on the absolute (kelvin) scale. The PID is specified at room temperature.
IDEAL_GAS_REF_K = 293.15


def table3_factor(factors, temp_c):
    """Look up a table value at any temperature, by drawing a straight line between
    the two nearest listed temperatures ("linear interpolation").

    Example: k'T is 1 at 20 degC and -1.2 at 30 degC, so at 25 degC (halfway) it is -0.1.
    Below -30 degC or above 50 degC, the value at the end of the table is used.
    """
    if temp_c <= TABLE3_TEMPS_C[0]:
        return factors[0]
    if temp_c >= TABLE3_TEMPS_C[-1]:
        return factors[-1]
    for i in range(len(TABLE3_TEMPS_C) - 1):
        t0, t1 = TABLE3_TEMPS_C[i], TABLE3_TEMPS_C[i + 1]
        if t0 <= temp_c <= t1:
            return factors[i] + (factors[i + 1] - factors[i]) * (temp_c - t0) / (t1 - t0)


def aan803_factor(algorithm, temp_c, gain_mv_per_na=None):
    """The H2S-B4 zero-correction factor for one algorithm at one temperature.

    For Algorithm 4 the factor is a current (nA), so it is turned into mV with the
    board's gain. Without a gain, Algorithm 4 cannot be used: this returns None.
    Example: k''T at 30 degC is -65 nA; x 0.8 mV/nA = -52 mV.
    """
    factor = table3_factor(H2S_B4_FACTORS[algorithm], temp_c)
    if algorithm == 4:
        return None if gain_mv_per_na is None else factor * gain_mv_per_na
    return factor


def aan803_corrected_we(algorithm, factor, we_u, we_e, we_t, ae_u=None, ae_e=None, ae_t=None):
    """The H2S working-electrode signal with the heat effect on the zero removed (mV).

    These are Alphasense's four formulas (AAN 803-05, Table 1). The names:
      we_u, ae_u   the raw WE and AE voltages measured now
      we_e, ae_e   the board's "electronic offsets": what the board itself adds,
                   printed on the ISB sheet ("Electronic Zero WE / AUX")
      we_t, ae_t   the total zeros (board + sensor), from the site zero or factory sheet
      we_o, ae_o   the sensor's own zeros = total zero - electronic offset
    The answer still has to be divided by the sensitivity to give ppb.
    At 20 degC, Algorithm 3 gives exactly the same answer as h2s_ppb above.
    """
    we_o = we_t - we_e
    if algorithm == 4:
        return (we_u - we_e) - we_o - factor
    ae_o = ae_t - ae_e
    if algorithm == 1:
        return (we_u - we_e) - factor * (ae_u - ae_e)
    if algorithm == 2:
        return (we_u - we_e) - factor * (we_o / ae_o) * (ae_u - ae_e)
    if algorithm == 3:
        return (we_u - we_e) - (we_o - ae_o) - factor * (ae_u - ae_e)
    raise ValueError(f"unknown AAN 803-05 algorithm {algorithm}")


def sensitivity_pct(sensor_model, temp_c):
    """How sensitive a sensor is at temp_c, as % of its 20 degC sensitivity.

    H2S-B4 and NH3-B1: read from the datasheet chart (tables above).
    PIDX-A-040: its datasheet says it follows the ideal gas law. Warm air is thinner,
    so fewer gas molecules reach the sensor: % = 100 x 293.15 / (273.15 + T).
    Example: at 40 degC the PID gives 93.6 % of its 20 degC signal.
    An unknown sensor model gives None (no correction).
    """
    model = (sensor_model or "").rstrip("+")       # "NH3-B1+" is the same sensor as "NH3-B1"
    if model in SENSITIVITY_PCT:
        return table3_factor(SENSITIVITY_PCT[model], temp_c)
    if model == "PIDX-A-040":
        return 100.0 * IDEAL_GAS_REF_K / (273.15 + temp_c)
    return None


# =============================================================================
# PART 3  Calibration records: which numbers to use for which reading
# =============================================================================
#
# A "calibration record" is one set of numbers for one sensor: its zero(s) and its
# sensitivity, plus where they came from ("source"):
#     "factory"    printed on the sensor's own factory calibration sheet
#     "site_zero"  the zero measured on the station itself in clean air, with the
#                  sensitivity still from the factory sheet (Alphasense's advice)
#     "datasheet"  Alphasense's typical values for that sensor type, used until the
#                  sensor's own sheet arrives (shown as "indicative")
#
# The rules (handover note, "The eight calibration rules"):
#   - A new calibration is always a NEW record. Old records are never edited.
#   - For each reading, use the record whose "valid from" is the latest one that is
#     not after the reading's time.
#   - No record means no number: the reading is marked "calibration missing".
#   - A negative result counts as 0, so every average is made of values of 0 or more.
#   - A channel stuck at the top or bottom of its range gets "sensor fault" and no number.

UNITS = {"H2S": "ppb", "NH3": "ppm", "VOC": "ppm"}


@dataclass(frozen=True)
class CalibrationRecord:
    """One set of calibration numbers for one sensor on one station."""
    station_id: str                      # which station, e.g. "aqms-monitor"
    channel: str                         # which gas: "H2S", "NH3" or "VOC"
    valid_from: datetime                 # from when these numbers apply (UTC)
    we_zero_mv: float                    # the zero (WE zero for H2S and NH3, V zero for VOC)
    sensitivity: float                   # mV per ppb for H2S; mV per ppm for NH3 and VOC
    ae_zero_mv: Optional[float] = None   # the AE zero, H2S only
    source: str = "factory"              # "factory", "site_zero" or "datasheet"
    fault_below_mv: Optional[float] = None  # VOC: below this the PID is broken (default: its zero)
    # Optional, for the H2S zero temperature correction later. Leave them empty until
    # the station sends its sensor temperature and the ISB sheets' numbers are known.
    we_electronic_mv: Optional[float] = None  # WEe, ISB sheet "Electronic Zero WE"
    ae_electronic_mv: Optional[float] = None  # AEe, ISB sheet "Electronic Zero AUX"
    temp_algorithm: Optional[int] = None      # which AAN 803-05 algorithm, 1 to 4
    gain_mv_per_na: Optional[float] = None    # the board's gain; only Algorithm 4 needs it
    record_id: str = ""                  # a name for the record, e.g. "CAL-NH3-SITE-0001"
    sensor_model: str = ""               # e.g. "H2S-B4", "NH3-B1+", "PIDX-A-040"
    sensor_serial: str = ""
    factory_sheet_ref: str = ""
    notes: str = ""


def parse_time(text):
    """Read a time like "2026-11-03T09:59:10Z" ("Z" means UTC, world time)."""
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def load_records(path):
    """Read all calibration records from a JSON file (like calibration_records.json).

    A record with a number missing is refused straight away, so a half-filled record
    can never be used by mistake.
    """
    with open(path, encoding="utf-8") as f:
        rows = json.load(f)["records"]
    records = []
    for row in rows:
        row = dict(row)
        missing = [k for k in ("valid_from", "we_zero_mv", "sensitivity") if row.get(k) is None]
        if row["channel"] == "H2S" and row.get("ae_zero_mv") is None:
            missing.append("ae_zero_mv")
        if missing:
            raise ValueError(f"record {row.get('record_id', '?')}: value missing: {', '.join(missing)}")
        row["valid_from"] = parse_time(row["valid_from"])
        records.append(CalibrationRecord(**row))
    return records


def record_in_force(records, station_id, channel, at):
    """The record to use for one reading: same station and gas, and the latest
    "valid from" that is not after the reading's time. None if there is none.

    Example: a reading on 1 Nov uses the site-zero record from 28 Oct, not the
    factory record from 1 Oct, because 28 Oct is later and still before 1 Nov.
    """
    candidates = [
        r for r in records
        if r.station_id == station_id and r.channel == channel and r.valid_from <= at
    ]
    return max(candidates, key=lambda r: r.valid_from, default=None)


@dataclass
class GasResult:
    """The answer for one gas in one reading."""
    value: Optional[float]     # the gas number, or None when there is no valid number
    unit: str                  # "ppb" or "ppm"
    valid: bool                # True = a good number; False = see "reason"
    reason: str = ""           # why there is no number, e.g. "sensor fault (channel stuck at rail)"
    record_id: str = ""        # which calibration record was used
    source: str = ""           # "factory", "site_zero" or "datasheet" (show it next to the value)
    temperature_corrected: bool = False  # True when the temperature changed the result
    zero_corrected: bool = False         # True when the H2S zero correction was used
    sensitivity_pct: float = 100.0       # the sensitivity used, as % of the 20 degC value


def convert_reading(records, station_id, at, h2s_we_mv=None, h2s_ae_mv=None, nh3_we_mv=None, voc_mv=None,
                    sensor_temp_c=None):
    """Turn ONE raw reading into H2S (ppb), NH3 (ppm) and VOC (ppm).

    at             the reading's time (UTC)
    *_mv           the four voltages in mV (None if missing)
    sensor_temp_c  the temperature at the top of the sensor, in degC: one number for
                   all three sensors, or a dict {"H2S": t, "NH3": t, "VOC": t}.
                   Until the station measures it, pass the Open-Meteo air temperature
                   for that hour. Leave it out for the plain 20 degC formulas.

    Returns {"H2S": GasResult, "NH3": GasResult, "VOC": GasResult}.
    """
    temps = sensor_temp_c if isinstance(sensor_temp_c, dict) else {g: sensor_temp_c for g in UNITS}
    return {
        "H2S": _convert(records, station_id, at, "H2S", h2s_we_mv, h2s_ae_mv, temps.get("H2S")),
        "NH3": _convert(records, station_id, at, "NH3", nh3_we_mv, temp_c=temps.get("NH3")),
        "VOC": _convert(records, station_id, at, "VOC", voc_mv, temp_c=temps.get("VOC")),
    }


def _h2s_corrected_we(rec, we_mv, ae_mv, temp_c):
    """The H2S signal with the zero corrected for temperature, or None when that
    cannot be done yet (no temperature, no algorithm chosen, or no electronic offsets)."""
    if (temp_c is None or rec.temp_algorithm is None or rec.we_electronic_mv is None
            or rec.ae_electronic_mv is None or rec.sensor_model.rstrip("+") != "H2S-B4"):
        return None
    factor = aan803_factor(rec.temp_algorithm, temp_c, rec.gain_mv_per_na)
    if factor is None:                     # Algorithm 4 without the board gain
        return None
    return aan803_corrected_we(rec.temp_algorithm, factor, we_mv, rec.we_electronic_mv, rec.we_zero_mv,
                               ae_mv, rec.ae_electronic_mv, rec.ae_zero_mv)


def _convert(records, station_id, at, channel, mv, ae_mv=None, temp_c=None):
    """One gas of one reading, in the same order as "Terra does all the maths" in the note."""
    unit = UNITS[channel]

    # 1. Find the calibration record. No record means no number.
    rec = record_in_force(records, station_id, channel, at)
    if rec is None:
        return GasResult(None, unit, False, "calibration missing")

    # 2. A missing voltage stays missing (it is never replaced by 0).
    if mv is None or (channel == "H2S" and ae_mv is None):
        return GasResult(None, unit, False, "voltage missing", rec.record_id)

    # 3. A voltage stuck at the top or bottom of its range is a sensor fault, not gas.
    if channel_at_rail(mv) or (ae_mv is not None and channel_at_rail(ae_mv)):
        return GasResult(None, unit, False, "sensor fault (channel stuck at rail)", rec.record_id, rec.source)

    # 4. The sensitivity at the sensor's temperature (100 % when there is no temperature).
    pct = sensitivity_pct(rec.sensor_model, temp_c) if temp_c is not None else None
    sensitivity = rec.sensitivity * (pct / 100.0 if pct is not None else 1.0)

    # 5. The recipe for this gas.
    zero_corrected = False
    if channel == "H2S":
        we_c = _h2s_corrected_we(rec, mv, ae_mv, temp_c)
        zero_corrected = we_c is not None
        value = we_c / sensitivity if zero_corrected else h2s_ppb(mv, rec.we_zero_mv, ae_mv, rec.ae_zero_mv, sensitivity)
    elif channel == "NH3":
        value = nh3_ppm(mv, rec.we_zero_mv, sensitivity)
    else:
        limit = rec.fault_below_mv if rec.fault_below_mv is not None else rec.we_zero_mv
        if voc_sensor_fault(mv, limit):
            return GasResult(None, unit, False, "sensor fault (below zero)", rec.record_id)
        value = voc_ppm(mv, rec.we_zero_mv, sensitivity)

    # 6. There can never be less than no gas. A small negative number is only noise
    #    around zero, so it counts as 0, and so does every average made from it.
    value = max(0.0, value)
    return GasResult(value, unit, True, "", rec.record_id, rec.source,
                     pct is not None or zero_corrected, zero_corrected, 100.0 if pct is None else pct)


# =============================================================================
# PART 4  Reading what the station sends
# =============================================================================
#
# The four channels:  A0 = NH3 WE,  A1 = H2S WE (also called OP1),
#                     A2 = H2S AE (OP2),  A3 = VOC (the PID).
#
# The test station sends one JSON record about every minute ("schema 4"). Inside it,
# "combinedString" is the same reading as one line of text. Older records used a
# different line style. All of them are read here:
#
#   the JSON record:   {"timestampUtc": "2026-11-03T09:59:10Z", "device": "aqms-monitor",
#                       "volts": [0.36734, 2.55422, 2.55391, 0.09812], "adcOk": true, ...}
#   the line (now):    2026-11-02,12:47:23,0.34969,0.43008,0.36375,0.10063,NA
#                      -> date, time, then A0, A1, A2, A3 in volts, then the STM32 status
#   the line (older):  2026-10-28,14:19:00,A0:raw=6286|volts=0.49109,A1:raw=6025|volts=0.47070,
#                      A2:raw=4597|volts=0.35914,A3:raw=1333|volts=0.10414,STM32:NA

FIELDS = ("nh3_we_mv", "h2s_we_mv", "h2s_ae_mv", "voc_mv")   # A0, A1, A2, A3, in that order
_CHANNEL = re.compile(r"A([0-3])\s*:\s*raw\s*=\s*(-?\d+(?:\.\d+)?)(?:\s*\|\s*volts\s*=\s*(-?\d+(?:\.\d+)?))?")
_STAMP = re.compile(r"^(\d{4}-\d{2}-\d{2})\s*,\s*(\d{2}:\d{2}:\d{2})")


def _utc(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)


def parse_packet(line):
    """Read one packet LINE (the "combinedString") into a time and four mV values.

    Returns {"time": UTC time, "nh3_we_mv", "h2s_we_mv", "h2s_ae_mv", "voc_mv"}.
    Volts are turned into mV (x 1000). "NA" or a missing channel stays None.
    """
    line = line.strip()
    stamp = _STAMP.match(line)
    if not stamp:
        raise ValueError("packet has no date and time at the start")
    out = {"time": _utc(f"{stamp.group(1)}T{stamp.group(2)}Z")}
    out.update({name: None for name in FIELDS})

    tagged = _CHANNEL.findall(line)
    if tagged:                                            # older A0:raw=..|volts=.. style
        for channel, counts, volts in tagged:
            out[FIELDS[int(channel)]] = float(volts) * 1000.0 if volts else counts_to_mv(float(counts))
        return out

    parts = [p.strip() for p in line.split(",")[2:6]]     # current style: four volts in order
    for name, part in zip(FIELDS, parts):
        try:
            out[name] = float(part) * 1000.0
        except ValueError:
            out[name] = None                              # e.g. "NA": missing stays missing
    return out


def parse_firebase_record(record):
    """Read one whole JSON record from the station (schema 4).

    What is used, and in what order of preference:
      time      timestampUtc; if missing, rtcUtc (the station's clock); if missing,
                ntpUtc (internet time); if missing, the date and time in combinedString
      voltages  volts (x 1000 = mV); if missing, raw converter counts (x 2560 / 32768);
                if missing, combinedString
      adcOk     false means the station's converter failed: no voltage can be trusted
    Passed on for the equipment alarms (never used in a gas formula): batteryV,
    sampleAgeMs, schemaVersion. Not used at all: a0Volts, h2sDiffV, averageCount,
    destination and the stm32 block.
    Returns the same shape as parse_packet, plus "station_id", "adc_ok", "battery_v",
    "sample_age_ms" and "schema_version".
    """
    stamp = record.get("timestampUtc") or record.get("rtcUtc") or record.get("ntpUtc")
    line = record.get("combinedString") or ""
    out = parse_packet(line) if line and (not stamp or not (record.get("volts") or record.get("raw"))) else {}
    if stamp:
        out["time"] = _utc(stamp)
    out["station_id"] = record.get("device")
    volts = record.get("volts") or []
    raw = record.get("raw") or []
    for i, name in enumerate(FIELDS):
        if i < len(volts) and volts[i] is not None:
            out[name] = float(volts[i]) * 1000.0
        elif i < len(raw) and raw[i] is not None:
            out[name] = counts_to_mv(float(raw[i]))
        else:
            out.setdefault(name, None)
    out["adc_ok"] = record.get("adcOk", True) is not False
    if not out["adc_ok"]:
        out.update({name: None for name in FIELDS})       # a failed converter read gives no voltages
    out["battery_v"] = record.get("batteryV")
    out["sample_age_ms"] = record.get("sampleAgeMs")
    out["schema_version"] = record.get("schemaVersion")
    return out


# =============================================================================
# PART 5  Averages, alarms and equipment (technical) alarms
# =============================================================================
#
# One reading jumps around too much to trust, so Terra averages the readings in each
# 10 minutes, and alarms only ever look at those averages.
# None means "invalid or missing". It is never replaced by 0 or by the last value;
# it is simply left out.


def window_average(values, minimum_valid=4):
    """The average of the valid readings in one window, or None if too few are valid.

    DM's rule: a 10-minute window has five 2-minute readings and needs at least 4
    valid ones. (The test station sends one a minute: then use minimum_valid=8 of 10.)
    Example: 10, 12, (bad), 11, 13 -> four valid -> (10 + 12 + 11 + 13) / 4 = 11.5.
    """
    valid = [v for v in values if v is not None]
    if len(valid) < minimum_valid:
        return None
    return sum(valid) / len(valid)


def period_completeness(values, expected_count):
    """The share of the expected readings that are valid, from 0 to 1."""
    valid = sum(1 for v in values if v is not None)
    return valid / expected_count if expected_count else 0.0


def is_complete(values, expected_count, required=0.75):
    """DM's rule: a report period with less than 75 % valid readings is "incomplete"."""
    return period_completeness(values, expected_count) >= required


def wind_direction_average(directions_deg):
    """The average wind direction in degrees (0 to 360), or None if there is none.

    A normal average does not work for directions: the average of 350 and 10 degrees
    must be 0 (north), but (350 + 10) / 2 gives 180 (south), exactly backwards.
    So: average the sines, average the cosines, then turn them back into an angle.
    Checks: 350 and 10 give 0; 80 and 100 give 90.
    """
    valid = [d for d in directions_deg if d is not None]
    if not valid:
        return None
    s = sum(math.sin(math.radians(d)) for d in valid) / len(valid)
    c = sum(math.cos(math.radians(d)) for d in valid) / len(valid)
    angle = math.degrees(math.atan2(s, c))
    if angle < 0:
        angle += 360.0
    return round(angle, 6) % 360.0


LEVELS = ("Warning", "Action", "Critical")      # from mild to serious


def thresholds(baseline_b, baseline_s, alarm_floor):
    """The three alarm lines for one station and one gas (DM's Monitoring Criteria).

    B = the normal level, S = how much it normally wobbles (both from the 30-day baseline).
    Each line is the bigger of the alarm floor and B + 2S, 3S or 4S. The floor is there
    so tiny noise near zero can never start an alarm.
    Example: B = 5, S = 2, floor = 8 -> Warning 9, Action 11, Critical 13.
    """
    return {
        "Warning": max(alarm_floor, baseline_b + 2 * baseline_s),
        "Action": max(alarm_floor, baseline_b + 3 * baseline_s),
        "Critical": max(alarm_floor, baseline_b + 4 * baseline_s),
    }


def rapid_rise(previous_three, newest, warning_threshold):
    """A sudden jump: the newest average is at least TWICE the middle value of the
    three before it, AND above Warning. That starts an Action alarm straight away.

    Example: the last three were 4, 6 and 5 (middle value 5). The new one is 12.
    12 >= 2 x 5 and 12 > Warning 9, so yes.
    """
    if len(previous_three) < 3:
        return False
    return newest >= 2 * median(previous_three) and newest > warning_threshold


class AlarmTracker:
    """Keeps the alarm for ONE station and ONE gas. There is never more than one
    alarm open at a time; it just moves up a level if things get worse.

    Feed it each finished 10-minute window with add_window(). An invalid window
    (None) is skipped: it does not count towards "in a row", and it does not break
    the row either.

    When an alarm STARTS:
      Warning   2 valid 10-minute averages in a row above Warning (or one 30-minute average)
      Action    2 in a row above Action (or one 30-minute average), or a rapid rise
      Critical  just 1 window above Critical: a Critical level cannot wait
    When it STOPS ("Cleared"):
      3 valid windows in a row below Warning, and for Action and Critical a person
      must also have acknowledged it. "Closed" = cleared AND acknowledged.
    """

    def __init__(self, station_id, gas, level_thresholds):
        self.station_id = station_id
        self.gas = gas
        self.t = level_thresholds          # {"Warning": .., "Action": .., "Critical": ..}
        self.level = None                  # the level now; None = no alarm
        self.acknowledged = False
        self._cleared_waiting_ack = False  # a Warning that cleared before anyone acknowledged it
        self.history = []                  # every event: (time, event, level, value, user)
        self._above = {lvl: 0 for lvl in LEVELS}   # how many windows in a row above each line
        self._below_warning = 0                    # how many windows in a row below Warning
        self._recent = []                  # the last three valid 10-minute averages

    def add_window(self, at, avg_10min, avg_30min=None):
        """Feed one finished 10-minute window. Returns the events it caused."""
        if avg_10min is None:
            return []                      # invalid window: skipped, the row is not broken

        # Count the windows in a row above each line, and below Warning.
        for lvl in LEVELS:
            self._above[lvl] = self._above[lvl] + 1 if avg_10min > self.t[lvl] else 0
        self._below_warning = self._below_warning + 1 if avg_10min < self.t["Warning"] else 0

        # Which level's start rule is met now (the highest one wins)?
        met = None
        if self._above["Warning"] >= 2 or (avg_30min is not None and avg_30min > self.t["Warning"]):
            met = "Warning"
        if (self._above["Action"] >= 2
                or (avg_30min is not None and avg_30min > self.t["Action"])
                or rapid_rise(self._recent[-3:], avg_10min, self.t["Warning"])):
            met = "Action"
        if avg_10min > self.t["Critical"]:
            met = "Critical"           # one window is enough; do not wait

        self._recent = (self._recent + [avg_10min])[-3:]
        events = []

        # Start a new alarm, or move the open one up a level ("Escalated").
        if met and (self.level is None or LEVELS.index(met) > LEVELS.index(self.level)):
            event = "Raised" if self.level is None else "Escalated"
            if self.level is None:
                self.acknowledged = False
            self.level = met
            events.append(self._log(at, event, avg_10min))

        # Stop the alarm after 3 windows below Warning (Action and Critical also need
        # an acknowledgement first).
        if self.level and self._below_warning >= 3:
            if self.level == "Warning" or self.acknowledged:
                events.append(self._log(at, "Cleared", avg_10min))
                if self.acknowledged:
                    events.append(self._log(at, "Closed", avg_10min))
                else:
                    self._cleared_waiting_ack = True   # Closed once someone acknowledges
                self.level = None
                self.acknowledged = False
        return events

    def acknowledge(self, at, user):
        """A person clicks "I have seen this". That alone never clears an alarm."""
        if self.level is None:
            if not self._cleared_waiting_ack:
                return []
            self._cleared_waiting_ack = False
            return [self._log(at, "Acknowledged", None, user), self._log(at, "Closed", None)]
        self.acknowledged = True
        return [self._log(at, "Acknowledged", None, user)]

    def _log(self, at, event, value, user=None):
        entry = (at, event, self.level, value, user)
        self.history.append(entry)
        return entry


# Equipment ("technical") alarms. They are about the equipment, not the air. They show
# in Terra for DM, clearly marked as equipment alarms, and DM tells Tridel.

def communication_lost(last_package_at, now, timeout_minutes=30):
    """True when nothing has arrived for more than 30 minutes (DM's Monitoring Criteria)."""
    return now - last_package_at > timedelta(minutes=timeout_minutes)


def flat_line(timed_values, minutes=60):
    """True when a gas has shown exactly the same value for more than 60 minutes.

    Real air never stays exactly the same for an hour, so this means a stuck sensor
    or logger. timed_values: a list of (time, value), oldest first, valid readings only.
    """
    if len(timed_values) < 2:
        return False
    last_time, last_value = timed_values[-1]
    start = last_time
    for t, v in reversed(timed_values):
        if v != last_value:
            break
        start = t
    return last_time - start > timedelta(minutes=minutes)
