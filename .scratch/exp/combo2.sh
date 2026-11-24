#!/bin/bash
# combo.sh: run several verify jobs inside one heavy slot. Each line of combo2.list: <file> <out> <symbols...>
D=/home/shaw/.cache/vibecut/tools/dafny
while read -r f o rest; do
  [ -z "$f" ] && continue
  : > "$o"
  for s in $rest; do echo "== $s" >> "$o"; dafny verify --standard-libraries --unicode-char:true --cores 3 --error-limit 0 --resource-limit 30000000 --show-snippets:false --verification-time-limit 0 --solver-path $D/z3/bin/z3-4.12.1 --isolate-assertions --filter-symbol "$s" "$f" 2>&1 | grep -v Warning | grep -v "^$" | tail -8 >> "$o"; done
  echo ALLDONE >> "$o"
done < combo2.list
