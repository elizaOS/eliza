#!/usr/bin/env sh
set -eu

if [ "$#" -ne 2 ]; then
	echo "usage: $0 /path/to/u-boot build|boot-chain" >&2
	exit 2
fi

uboot=$1
mode=$2
repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/../../.." && pwd)
evidence_dir="$repo_root/docs/evidence/linux"

if [ ! -f "$uboot/Makefile" ] || [ ! -d "$uboot/arch" ] || [ ! -d "$uboot/configs" ]; then
	echo "error: $uboot does not look like a U-Boot checkout" >&2
	exit 1
fi

mkdir -p "$evidence_dir"

timestamp_utc() {
	date -u '+%Y-%m-%dT%H:%M:%SZ'
}

record_uboot_command() {
	artifact=$1
	log=$2
	command=$3
	{
		echo "eliza-evidence: target=u-boot artifact=$artifact"
		echo "eliza-evidence: command=$command"
		started=$(timestamp_utc)
		echo "eliza-evidence: started_utc=$started"
		echo "eliza-evidence: uboot=$uboot"
		echo "EXTERNAL_TREE=$uboot"
		echo "COMMAND=$command"
		echo "START_UTC=$started"
	} > "$log"
	set +e
	(cd "$uboot" && sh -c "$command") >> "$log" 2>&1
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
		if [ -z "${ELIZA_UBOOT_CMD:-}" ]; then
			echo "error: set ELIZA_UBOOT_CMD to the external U-Boot build command" >&2
			exit 2
		fi
		record_uboot_command \
			u_boot_eliza_build \
			"$evidence_dir/u_boot_eliza_build.log" \
			"$ELIZA_UBOOT_CMD"
		;;
	boot-chain)
		if [ -z "${ELIZA_UBOOT_BOOT_CMD:-}" ]; then
			echo "error: set ELIZA_UBOOT_BOOT_CMD to the external boot-chain command" >&2
			exit 2
		fi
		record_uboot_command \
			u_boot_opensbi_boot_chain \
			"$evidence_dir/u_boot_opensbi_boot_chain.log" \
			"$ELIZA_UBOOT_BOOT_CMD"
		;;
	*)
		echo "error: unknown mode $mode" >&2
		exit 2
		;;
esac
