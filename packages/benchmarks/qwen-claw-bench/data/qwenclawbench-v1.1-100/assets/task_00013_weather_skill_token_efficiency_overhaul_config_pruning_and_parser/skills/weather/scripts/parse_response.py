#!/usr/bin/env python3
"""
parse_response.py — Parse and format weather API response.

Currently: passes through the raw JSON response without filtering.
TODO: Add filtering/summarization to reduce token usage.
"""

import json
import sys


def parse_weather(data: dict) -> str:
    """Format weather data for output.
    
    Currently returns the full JSON blob.
    This is wasteful — a 7-day hourly forecast with all params
    can be 40-80KB of JSON, easily 15,000+ tokens.
    """
    # Just dump everything — "maximum detail"
    return json.dumps(data, indent=2, ensure_ascii=False)


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], 'r') as f:
            data = json.load(f)
    else:
        data = json.load(sys.stdin)
    
    print(parse_weather(data))


if __name__ == "__main__":
    main()
