#!/usr/bin/env python3
"""Verify decoded.jsonl against expected packet data."""

import json
import math
import os
import sys


EXPECTED = json.loads('[{"type": "HANDSHAKE", "seq": 0, "flags": 0, "hostname": "sensor-node-01", "firmware_ver": "1.0", "crc_valid": true}, {"type": "HANDSHAKE", "seq": 1, "flags": 0, "hostname": "gateway-east", "firmware_ver": "3.7", "crc_valid": false}, {"type": "HANDSHAKE", "seq": 2, "flags": 128, "hostname": "controller-main", "firmware_ver": "2.4", "crc_valid": true}, {"type": "DATA", "seq": 3, "flags": 0, "sensor_id": 95, "value": -23.6, "timestamp": 1700000000, "message": "speed ok", "crc_valid": true}, {"type": "DATA", "seq": 4, "flags": 0, "sensor_id": 76, "value": 27.51, "timestamp": 1700000060, "message": "temperature normal", "crc_valid": true}, {"type": "DATA", "seq": 5, "flags": 0, "sensor_id": 28, "value": -2.77, "timestamp": 1700000120, "message": "signal strong", "crc_valid": true}, {"type": "DATA", "seq": 6, "flags": 3, "sensor_id": 72, "value": -8.19, "timestamp": 1700000180, "message": "battery low", "crc_valid": true}, {"type": "DATA", "seq": 7, "flags": 0, "sensor_id": 29, "value": 31.87, "timestamp": 1700000240, "message": "current within range", "crc_valid": true}, {"type": "DATA", "seq": 8, "flags": 130, "sensor_id": 98, "value": 88.93, "timestamp": 1700000300, "message": "flow rate nominal", "crc_valid": true}, {"type": "DATA", "seq": 9, "flags": 0, "sensor_id": 20, "value": -5.55, "timestamp": 1700000360, "message": "vibration detected", "crc_valid": true}, {"type": "DATA", "seq": 10, "flags": 2, "sensor_id": 12, "value": 20.79, "timestamp": 1700000420, "message": "vibration detected", "crc_valid": true}, {"type": "DATA", "seq": 11, "flags": 3, "sensor_id": 78, "value": 2.32, "timestamp": 1700000480, "message": "temperature normal", "crc_valid": true}, {"type": "DATA", "seq": 12, "flags": 0, "sensor_id": 69, "value": -20.03, "timestamp": 1700000540, "message": "flow rate nominal", "crc_valid": true}, {"type": "DATA", "seq": 13, "flags": 2, "sensor_id": 71, "value": 6.91, "timestamp": 1700000600, "message": "battery low", "crc_valid": false}, {"type": "DATA", "seq": 14, "flags": 0, "sensor_id": 74, "value": -9.23, "timestamp": 1700000660, "message": "pressure high", "crc_valid": true}, {"type": "DATA", "seq": 15, "flags": 0, "sensor_id": 85, "value": -3.54, "timestamp": 1700000720, "message": "current within range", "crc_valid": true}, {"type": "DATA", "seq": 16, "flags": 2, "sensor_id": 30, "value": 98.64, "timestamp": 1700000780, "message": "flow rate nominal", "crc_valid": true}, {"type": "DATA", "seq": 17, "flags": 1, "sensor_id": 59, "value": 61.71, "timestamp": 1700000840, "message": "vibration detected", "crc_valid": true}, {"type": "DATA", "seq": 18, "flags": 130, "sensor_id": 48, "value": 16.84, "timestamp": 1700000900, "message": "battery low", "crc_valid": true}, {"type": "DATA", "seq": 19, "flags": 1, "sensor_id": 88, "value": 63.69, "timestamp": 1700000960, "message": "signal strong", "crc_valid": true}, {"type": "DATA", "seq": 20, "flags": 3, "sensor_id": 69, "value": 76.66, "timestamp": 1700001020, "message": "humidity ok", "crc_valid": true}, {"type": "DATA", "seq": 21, "flags": 1, "sensor_id": 49, "value": 3.19, "timestamp": 1700001080, "message": "battery low", "crc_valid": true}, {"type": "DATA", "seq": 22, "flags": 1, "sensor_id": 88, "value": 11.89, "timestamp": 1700001140, "message": "temperature normal", "crc_valid": true}, {"type": "DATA", "seq": 23, "flags": 2, "sensor_id": 5, "value": 88.81, "timestamp": 1700001200, "message": "flow rate nominal", "crc_valid": true}, {"type": "DATA", "seq": 24, "flags": 2, "sensor_id": 9, "value": -6.24, "timestamp": 1700001260, "message": "signal strong", "crc_valid": true}, {"type": "DATA", "seq": 25, "flags": 3, "sensor_id": 28, "value": 64.87, "timestamp": 1700001320, "message": "flow rate nominal", "crc_valid": true}, {"type": "DATA", "seq": 26, "flags": 2, "sensor_id": 19, "value": 2.38, "timestamp": 1700001380, "message": "voltage stable", "crc_valid": true}, {"type": "DATA", "seq": 27, "flags": 3, "sensor_id": 96, "value": 53.53, "timestamp": 1700001440, "message": "signal strong", "crc_valid": true}, {"type": "DATA", "seq": 28, "flags": 131, "sensor_id": 47, "value": -4.91, "timestamp": 1700001500, "message": "humidity ok", "crc_valid": true}, {"type": "DATA", "seq": 29, "flags": 1, "sensor_id": 97, "value": -32.46, "timestamp": 1700001560, "message": "pressure high", "crc_valid": true}, {"type": "DATA", "seq": 30, "flags": 3, "sensor_id": 81, "value": -14.4, "timestamp": 1700001620, "message": "battery low", "crc_valid": true}, {"type": "DATA", "seq": 31, "flags": 3, "sensor_id": 77, "value": -29.84, "timestamp": 1700001680, "message": "flow rate nominal", "crc_valid": true}, {"type": "DATA", "seq": 32, "flags": 0, "sensor_id": 68, "value": 0.23, "timestamp": 1700001740, "message": "speed ok", "crc_valid": true}, {"type": "DATA", "seq": 33, "flags": 2, "sensor_id": 88, "value": 75.32, "timestamp": 1700001800, "message": "battery low", "crc_valid": false}, {"type": "DATA", "seq": 34, "flags": 2, "sensor_id": 99, "value": 62.55, "timestamp": 1700001860, "message": "pressure high", "crc_valid": true}, {"type": "DATA", "seq": 35, "flags": 2, "sensor_id": 56, "value": -14.69, "timestamp": 1700001920, "message": "temperature normal", "crc_valid": true}, {"type": "DATA", "seq": 36, "flags": 0, "sensor_id": 65, "value": 81.91, "timestamp": 1700001980, "message": "speed ok", "crc_valid": true}, {"type": "DATA", "seq": 37, "flags": 1, "sensor_id": 81, "value": 7.75, "timestamp": 1700002040, "message": "battery low", "crc_valid": true}, {"type": "DATA", "seq": 38, "flags": 0, "sensor_id": 20, "value": 19.83, "timestamp": 1700002100, "message": "humidity ok", "crc_valid": true}, {"type": "DATA", "seq": 39, "flags": 0, "sensor_id": 77, "value": 11.86, "timestamp": 1700002160, "message": "temperature normal", "crc_valid": true}, {"type": "DATA", "seq": 40, "flags": 1, "sensor_id": 47, "value": 100.6, "timestamp": 1700002220, "message": "current within range", "crc_valid": true}, {"type": "DATA", "seq": 41, "flags": 0, "sensor_id": 8, "value": -1.46, "timestamp": 1700002280, "message": "signal strong", "crc_valid": true}, {"type": "DATA", "seq": 42, "flags": 1, "sensor_id": 11, "value": 77.11, "timestamp": 1700002340, "message": "pressure high", "crc_valid": true}, {"type": "DATA", "seq": 43, "flags": 129, "sensor_id": 17, "value": 65.56, "timestamp": 1700002400, "message": "speed ok", "crc_valid": true}, {"type": "DATA", "seq": 44, "flags": 1, "sensor_id": 68, "value": 99.59, "timestamp": 1700002460, "message": "flow rate nominal", "crc_valid": true}, {"type": "DATA", "seq": 45, "flags": 2, "sensor_id": 70, "value": 80.84, "timestamp": 1700002520, "message": "voltage stable", "crc_valid": true}, {"type": "DATA", "seq": 46, "flags": 2, "sensor_id": 52, "value": 119.22, "timestamp": 1700002580, "message": "battery low", "crc_valid": true}, {"type": "DATA", "seq": 47, "flags": 0, "sensor_id": 57, "value": 103.94, "timestamp": 1700002640, "message": "level warning", "crc_valid": true}, {"type": "DATA", "seq": 48, "flags": 0, "sensor_id": 32, "value": -4.05, "timestamp": 1700002700, "message": "vibration detected", "crc_valid": true}, {"type": "DATA", "seq": 49, "flags": 1, "sensor_id": 76, "value": 48.63, "timestamp": 1700002760, "message": "signal strong", "crc_valid": true}, {"type": "DATA", "seq": 50, "flags": 0, "sensor_id": 1, "value": -28.64, "timestamp": 1700002820, "message": "battery low", "crc_valid": true}, {"type": "HEARTBEAT", "seq": 51, "flags": 0, "uptime_seconds": 121031, "crc_valid": true}, {"type": "HEARTBEAT", "seq": 52, "flags": 0, "uptime_seconds": 36337, "crc_valid": true}, {"type": "HEARTBEAT", "seq": 53, "flags": 0, "uptime_seconds": 475700, "crc_valid": true}, {"type": "HEARTBEAT", "seq": 54, "flags": 0, "uptime_seconds": 17469, "crc_valid": false}, {"type": "HEARTBEAT", "seq": 55, "flags": 0, "uptime_seconds": 451696, "crc_valid": true}, {"type": "HEARTBEAT", "seq": 56, "flags": 0, "uptime_seconds": 174239, "crc_valid": true}, {"type": "HEARTBEAT", "seq": 57, "flags": 128, "uptime_seconds": 38149, "crc_valid": true}, {"type": "HEARTBEAT", "seq": 58, "flags": 0, "uptime_seconds": 270565, "crc_valid": true}, {"type": "CLOSE", "seq": 59, "flags": 0, "reason_code": 0, "message": "normal shutdown", "crc_valid": true}, {"type": "CLOSE", "seq": 60, "flags": 0, "reason_code": 1, "message": "timeout", "crc_valid": true}, {"type": "CLOSE", "seq": 61, "flags": 0, "reason_code": 2, "message": "protocol error", "crc_valid": true}, {"type": "CONFIG", "seq": 62, "flags": 0, "entries": {"sample_rate": "1000", "threshold": "85.5", "mode": "continuous"}, "crc_valid": true}, {"type": "CONFIG", "seq": 63, "flags": 0, "entries": {"log_level": "debug", "output": "serial"}, "crc_valid": true}, {"type": "CONFIG", "seq": 64, "flags": 128, "entries": {"calibration": "auto", "sensor_type": "thermocouple", "unit": "celsius", "precision": "high"}, "crc_valid": true}, {"type": "CONFIG", "seq": 65, "flags": 0, "entries": {"node_id": "42", "network": "mesh-alpha"}, "crc_valid": true}, {"type": "CONFIG", "seq": 66, "flags": 0, "entries": {"firmware_url": "http://update.local/fw", "check_interval": "3600"}, "crc_valid": false}, {"type": "ERROR", "seq": 67, "flags": 0, "error_code": 100, "severity": 1, "message": "sensor timeout", "crc_valid": true}, {"type": "ERROR", "seq": 68, "flags": 0, "error_code": 201, "severity": 2, "message": "calibration failed: out of range", "crc_valid": true}, {"type": "ERROR", "seq": 69, "flags": 0, "error_code": 500, "severity": 3, "message": "internal error: watchdog reset", "crc_valid": true}]')


def compare_packet(got: dict, exp: dict) -> bool:
    """Check if a decoded packet matches the expected packet."""
    if got.get("type") != exp.get("type"):
        return False
    if got.get("seq") != exp.get("seq"):
        return False
    if got.get("flags") != exp.get("flags"):
        return False
    if got.get("crc_valid") != exp.get("crc_valid"):
        return False

    ptype = exp["type"]
    if ptype == "HANDSHAKE":
        if got.get("hostname") != exp.get("hostname"):
            return False
        if got.get("firmware_ver") != exp.get("firmware_ver"):
            return False
    elif ptype == "DATA":
        if got.get("sensor_id") != exp.get("sensor_id"):
            return False
        if got.get("timestamp") != exp.get("timestamp"):
            return False
        if got.get("message") != exp.get("message"):
            return False
        try:
            if not math.isclose(float(got.get("value", 0)), float(exp.get("value", 0)),
                                rel_tol=1e-2, abs_tol=0.01):
                return False
        except (TypeError, ValueError):
            return False
    elif ptype == "HEARTBEAT":
        if got.get("uptime_seconds") != exp.get("uptime_seconds"):
            return False
    elif ptype == "CLOSE":
        if got.get("reason_code") != exp.get("reason_code"):
            return False
        if got.get("message") != exp.get("message"):
            return False
    elif ptype == "CONFIG":
        exp_entries = exp.get("entries", {})
        got_entries = got.get("entries", {})
        if isinstance(got_entries, list):
            # Accept list-of-dicts format too
            got_entries = {}
            for item in got.get("entries", []):
                if isinstance(item, dict):
                    for k, v in item.items():
                        got_entries[k] = v
        if got_entries != exp_entries:
            return False
    elif ptype == "ERROR":
        if got.get("error_code") != exp.get("error_code"):
            return False
        if got.get("severity") != exp.get("severity"):
            return False
        if got.get("message") != exp.get("message"):
            return False

    return True


def main():
    result = {
        "decoder_exists": False,
        "jsonl_exists": False,
        "jsonl_line_count": 0,
        "expected_count": len(EXPECTED),
        "correct_packets": 0,
        "corrupt_detected": 0,
        "corrupt_expected": 0,
        "packet_accuracy": 0.0,
        "crc_accuracy": 0.0,
        "overall_score": 0.0,
    }

    decoder_path = "/workspace/decode.py"
    jsonl_path = "/workspace/decoded.jsonl"

    result["decoder_exists"] = os.path.isfile(decoder_path)

    if not os.path.isfile(jsonl_path):
        print(json.dumps(result))
        return

    result["jsonl_exists"] = True

    decoded_packets = []
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    decoded_packets.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

    result["jsonl_line_count"] = len(decoded_packets)

    corrupt_expected = [e for e in EXPECTED if not e.get("crc_valid", True)]
    result["corrupt_expected"] = len(corrupt_expected)

    # Match by sequence number
    decoded_by_seq = {}
    for pkt in decoded_packets:
        s = pkt.get("seq")
        if s is not None:
            decoded_by_seq[s] = pkt

    correct = 0
    valid_expected = [e for e in EXPECTED if e.get("crc_valid", True)]
    for exp in valid_expected:
        got = decoded_by_seq.get(exp["seq"])
        if got and compare_packet(got, exp):
            correct += 1

    result["correct_packets"] = correct

    corrupt_detected = 0
    for exp in corrupt_expected:
        got = decoded_by_seq.get(exp["seq"])
        if got and got.get("crc_valid") is False:
            corrupt_detected += 1
    result["corrupt_detected"] = corrupt_detected

    total_valid = len(valid_expected)
    if total_valid > 0:
        result["packet_accuracy"] = round(correct / total_valid, 4)
    if len(corrupt_expected) > 0:
        result["crc_accuracy"] = round(corrupt_detected / len(corrupt_expected), 4)

    score = 0.0
    if result["decoder_exists"]:
        score += 0.05
    if result["jsonl_exists"] and result["jsonl_line_count"] >= 0.8 * len(EXPECTED):
        score += 0.05 + 0.05
    elif result["jsonl_exists"]:
        score += 0.05
    score += 0.55 * result["packet_accuracy"]
    score += 0.30 * result["crc_accuracy"]
    result["overall_score"] = round(score, 4)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
