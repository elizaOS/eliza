#!/bin/bash
# dump every proof unit with the working print.ts and with HEAD's, then list units whose text differs
cd /home/shaw/.cache/vibecut/res-proof-headers
rm -rf .scratch/dump-new .scratch/dump-old
node .prove-units.ts . --dump .scratch/dump-new > .scratch/dump-new.log 2>&1
cp vibestack/gen/print.ts .scratch/print.ts.new
git show HEAD:vibestack/gen/print.ts > vibestack/gen/print.ts
node .prove-units.ts . --dump .scratch/dump-old > .scratch/dump-old.log 2>&1
cp .scratch/print.ts.new vibestack/gen/print.ts
diff -rq .scratch/dump-old .scratch/dump-new > .scratch/dump-diff.txt
echo done
