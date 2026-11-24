#!/bin/bash
# verify.sh <file.dfy> <out> <symbol>... : verifies each symbol in turn inside one heavy slot
f=$1; o=$2; shift 2
D=/home/shaw/.cache/vibecut/tools/dafny
/home/shaw/.cache/vibecut/heavy.sh "$(dirname "$(realpath "$f")")" 4 bash -c '
f=$1; shift; D=/home/shaw/.cache/vibecut/tools/dafny
for s in "$@"; do echo "== $s"; dafny verify --standard-libraries --unicode-char:true --cores 2 --error-limit 0 --resource-limit 30000000 --show-snippets:false --verification-time-limit 0 --solver-path $D/z3/bin/z3-4.12.1 --isolate-assertions --filter-symbol "$s" "$f" 2>&1 | grep -v Warning | grep -v "^$" | tail -8; done; echo ALLDONE' _ "$(basename "$f")" "$@" > "$o"
