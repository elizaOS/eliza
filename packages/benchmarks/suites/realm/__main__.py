#!/usr/bin/env python3
"""
REALM-Bench entry point.

Allows running the benchmark as: python -m benchmarks.realm
"""

import sys

from benchmarks.realm.cli import main

if __name__ == "__main__":
    sys.exit(main())
