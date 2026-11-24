#!/bin/bash
cd /home/shaw/.cache/vibecut/res-proof-headers
node .prove-units.ts . --deps $(cat "$1") > "$2" 2>&1
echo "rc=$?" >> "$2"
