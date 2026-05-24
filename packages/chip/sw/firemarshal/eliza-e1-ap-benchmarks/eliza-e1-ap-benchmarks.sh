#!/bin/sh
set -eu

REPORT=/tmp/eliza-e1-ap-benchmarks.report
COREMARK=/usr/bin/coremark
STREAM=/usr/bin/stream_c.exe
LAT_MEM_RD=/usr/bin/lat_mem_rd
FIO=/usr/bin/fio
FIO_JOB=/root/ufs-dram-contention.fio

emit() {
	echo "$1"
}

missing=0
emit "eliza-evidence: target=generated_chipyard_ap artifact=eliza-e1-ap-benchmarks"

for item in "$COREMARK" "$STREAM" "$LAT_MEM_RD" "$FIO" "$FIO_JOB"; do
	if [ ! -e "$item" ]; then
		emit "ap-benchmarks: BLOCKED missing_target_artifact=$item"
		missing=1
	fi
done

if [ "$missing" -ne 0 ]; then
	emit "ap-benchmarks: BLOCKED no PASS evidence emitted"
	exit 2
fi

{
	echo "claim_level=L3"
	echo "cpu frequency: generated AP runtime source=/proc/cpuinfo"
	grep -m1 -E 'cpu MHz|BogoMIPS|isa' /proc/cpuinfo || true
	echo "run count: 1"
	echo "thermal state: generated-AP simulator no calibrated thermal sensor"
	echo "power method: simulator transcript only, no board power rail measurement"
	echo "process effects contract: simulator-only benchmark, no silicon process evidence"
	echo "process corner count: 0"
	echo "worst process corner: none"
	echo "frequency derate: none, simulator-only"
	echo "pdk signoff claim=none"
	echo "CoreMark/MHz:"
	"$COREMARK" 2>&1
	echo "STREAM Triad:"
	"$STREAM" 2>&1
	echo "lat_mem_rd:"
	"$LAT_MEM_RD" 32M 128 2>&1
	echo "fio:"
	mkdir -p /data/local/tmp /tmp
	"$FIO" --output-format=json "$FIO_JOB" 2>&1
} > "$REPORT"

sha="$(sha256sum "$REPORT" | awk '{print $1}')"
emit "benchmark report sha256: $sha"
cat "$REPORT"
emit "eliza-evidence: status=PASS"
