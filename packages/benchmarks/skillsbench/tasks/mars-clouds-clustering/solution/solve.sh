#!/bin/bash
set -e

# The solution directory is mounted at /solution by Harbor
cd /root
python3 /solution/solve.py
