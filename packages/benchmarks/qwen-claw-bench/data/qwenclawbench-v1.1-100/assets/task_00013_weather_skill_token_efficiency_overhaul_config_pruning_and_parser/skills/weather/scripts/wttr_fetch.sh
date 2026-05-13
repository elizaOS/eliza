#!/bin/bash
# wttr_fetch.sh — Fetch weather from wttr.in (fallback)
# Usage: ./wttr_fetch.sh <location>

set -euo pipefail

LOCATION="${1:?Usage: wttr_fetch.sh <location>}"
ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$LOCATION'))")

# Fetch full JSON format (j1 = verbose JSON with everything)
curl -s "https://wttr.in/${ENCODED}?format=j1"
