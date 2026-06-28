#!/usr/bin/env sh
set -eu

if [ "$#" -ne 2 ]; then
	echo "usage: $0 /path/to/opensbi build|handoff" >&2
	exit 2
fi

opensbi=$1
mode=$2
repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/../../.." && pwd)
evidence_dir="$repo_root/docs/evidence/linux"

if [ ! -f "$opensbi/Makefile" ] || [ ! -d "$opensbi/lib" ]; then
	echo "error: $opensbi does not look like an OpenSBI checkout" >&2
	exit 1
fi

mkdir -p "$evidence_dir"

timestamp_utc() {
	date -u '+%Y-%m-%dT%H:%M:%SZ'
}

record_opensbi_command() {
	artifact=$1
	log=$2
	command=$3
	{
		echo "eliza-evidence: target=opensbi artifact=$artifact"
		echo "eliza-evidence: command=$command"
		started=$(timestamp_utc)
		echo "eliza-evidence: started_utc=$started"
		echo "eliza-evidence: opensbi=$opensbi"
		echo "EXTERNAL_TREE=$opensbi"
		echo "COMMAND=$command"
		echo "START_UTC=$started"
	} > "$log"
	set +e
	(cd "$opensbi" && sh -c "$command") >> "$log" 2>&1
	rc=$?
	set -e
	if [ "$rc" -eq 0 ]; then
		echo "eliza-evidence: status=PASS" >> "$log"
		echo "RESULT=PASS" >> "$log"
	else
		echo "eliza-evidence: status=FAIL rc=$rc" >> "$log"
		echo "RESULT=FAIL rc=$rc" >> "$log"
	fi
	ended=$(timestamp_utc)
	echo "eliza-evidence: ended_utc=$ended" >> "$log"
	echo "END_UTC=$ended" >> "$log"
	exit "$rc"
}

case "$mode" in
	build)
		record_opensbi_command \
			opensbi_eliza_build \
			"$evidence_dir/opensbi_eliza_build.log" \
			"${ELIZA_OPENSBI_CMD:-make PLATFORM=generic FW_DYNAMIC=y}"
		;;
	handoff)
		if [ -z "${ELIZA_OPENSBI_HANDOFF_CMD:-}" ]; then
			echo "error: set ELIZA_OPENSBI_HANDOFF_CMD to the external boot command" >&2
			exit 2
		fi
		record_opensbi_command \
			opensbi_fw_dynamic_handoff \
			"$evidence_dir/opensbi_fw_dynamic_handoff.log" \
			"$ELIZA_OPENSBI_HANDOFF_CMD"
		;;
	*)
		echo "error: unknown mode $mode" >&2
		exit 2
		;;
esac
