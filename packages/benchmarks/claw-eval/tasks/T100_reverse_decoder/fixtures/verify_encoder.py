#!/usr/bin/env python3
"""Verify that encoded.dat decodes correctly and meets size constraint."""

import json
import os
import subprocess
import sys


def main():
    result = {
        "file_exists": False,
        "decode_success": False,
        "exact_match": False,
        "char_match_ratio": 0.0,
        "encoded_size": 0,
        "target_size": 0,
        "size_ratio": 0.0,
        "size_within_60pct": False,
        "size_within_75pct": False,
        "overall_score": 0.0,
    }

    encoded_path = "/workspace/encoded.dat"
    target_path = "/workspace/fixtures/target.txt"
    decoder_path = "/workspace/fixtures/decoder.py"

    if not os.path.isfile(encoded_path):
        print(json.dumps(result))
        return

    result["file_exists"] = True
    result["encoded_size"] = os.path.getsize(encoded_path)

    with open(target_path, "rb") as f:
        target = f.read()
    result["target_size"] = len(target)

    if result["target_size"] > 0:
        result["size_ratio"] = round(result["encoded_size"] / result["target_size"], 4)
        result["size_within_60pct"] = result["size_ratio"] <= 0.60
        result["size_within_75pct"] = result["size_ratio"] <= 0.75

    try:
        proc = subprocess.run(
            ["python", decoder_path],
            stdin=open(encoded_path, "rb"),
            capture_output=True,
            timeout=10,
        )
        if proc.returncode == 0:
            decoded = proc.stdout
            result["decode_success"] = True
            result["exact_match"] = decoded == target

            if len(target) > 0:
                match_count = sum(
                    1 for a, b in zip(decoded, target) if a == b
                )
                result["char_match_ratio"] = round(match_count / len(target), 4)
        else:
            result["decode_success"] = False
    except Exception:
        result["decode_success"] = False

    score = 0.0
    if result["file_exists"]:
        score += 0.05
    if result["exact_match"]:
        score += 0.65
    elif result["decode_success"]:
        score += 0.65 * result["char_match_ratio"]
    if result["size_within_60pct"]:
        score += 0.30
    elif result["size_within_75pct"]:
        score += 0.15
    result["overall_score"] = round(score, 4)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
