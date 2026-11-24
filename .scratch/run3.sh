#!/bin/bash
cd /home/shaw/.cache/vibecut/res-proof-headers
node .prove-units.ts . --list > .scratch/list.out 2>&1
node .prove-units.ts . --deps $(cat .units2) > .p-run3.log 2>&1
echo "rc=$?" >> .p-run3.log
