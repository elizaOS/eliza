#!/usr/bin/env python3
"""
REALM-Bench entry point.

Allows running the benchmark as: python -m benchmarks.suites.realm
"""

import sys

from benchmarks.suites.realm.cli import main

if __name__ == "__main__":
    sys.exit(main())
