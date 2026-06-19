#!/usr/bin/env sh
set -eu

if [ "$#" -ne 2 ]; then
	echo "usage: $0 /path/to/buildroot defconfig|image-manifest|smoke|ml-smoke" >&2
	exit 2
fi

buildroot=$1
mode=$2
repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/../../.." && pwd)
external="$repo_root/sw/buildroot"
evidence_dir="$repo_root/docs/evidence/buildroot"

if [ ! -f "$buildroot/Makefile" ] || [ ! -d "$buildroot/configs" ]; then
	echo "error: $buildroot does not look like a Buildroot checkout" >&2
	exit 1
fi

mkdir -p "$evidence_dir"

timestamp_utc() {
	date -u '+%Y-%m-%dT%H:%M:%SZ'
}

record_command() {
	artifact=$1
	log=$2
	command=$3
	{
		echo "eliza-evidence: target=buildroot artifact=$artifact"
		echo "eliza-evidence: command=$command"
		started=$(timestamp_utc)
		echo "eliza-evidence: started_utc=$started"
		echo "eliza-evidence: buildroot=$buildroot"
		echo "eliza-evidence: br2_external=$external"
		echo "EXTERNAL_TREE=$buildroot"
		echo "COMMAND=$command"
		echo "START_UTC=$started"
	} > "$log"
	set +e
	(cd "$buildroot" && sh -c "$command") >> "$log" 2>&1
	rc=$?
	set -e
	if [ "$rc" -eq 0 ]; then
		if [ "$artifact" = "e1-mmio-smoke" ]; then
			echo "E1_MMIO_SMOKE_PASS" >> "$log"
		elif [ "$artifact" = "e1-npu-ml-smoke" ]; then
			echo "E1_NPU_ML_SMOKE_PASS" >> "$log"
		fi
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
	defconfig)
		record_command \
			eliza_e1_defconfig \
			"$evidence_dir/eliza_e1_defconfig.log" \
			"make BR2_EXTERNAL=$external eliza_e1_defconfig && grep -E '^(BR2_EXTERNAL_ELIZA_E1_PATH|BR2_PACKAGE_E1_MMIO_SMOKE|BR2_PACKAGE_E1_NPU_ML_SMOKE|BR2_PACKAGE_ELIZA_E1_BSP)=' .config"
		;;
	image-manifest)
		log="$evidence_dir/eliza_e1_image_manifest.txt"
		images="$buildroot/output/images"
		{
			echo "eliza-evidence: target=buildroot artifact=eliza_e1_image_manifest"
			echo "eliza-evidence: buildroot_config=eliza_e1_defconfig"
			echo "eliza-evidence: command=find output/images -maxdepth 1 -type f -print -exec sha256sum {} ;"
			started=$(timestamp_utc)
			echo "eliza-evidence: started_utc=$started"
			echo "eliza-evidence: buildroot=$buildroot"
			echo "eliza-evidence: br2_external=$external"
			echo "EXTERNAL_TREE=$buildroot"
			echo "COMMAND=find output/images -maxdepth 1 -type f -print -exec sha256sum {} ;"
			echo "START_UTC=$started"
			} > "$log"
			if [ ! -d "$images" ]; then
				{
					echo "error: missing $images; run the Buildroot image build first"
					echo "eliza-evidence: status=FAIL"
					echo "RESULT=FAIL"
					ended=$(timestamp_utc)
					echo "eliza-evidence: ended_utc=$ended"
					echo "END_UTC=$ended"
				} >> "$log"
				exit 1
			fi
		(
			cd "$buildroot"
			find output/images -maxdepth 1 -type f -print -exec sha256sum {} \;
		) >> "$log" 2>&1
		echo "eliza-evidence: status=PASS" >> "$log"
		echo "RESULT=PASS" >> "$log"
		ended=$(timestamp_utc)
		echo "eliza-evidence: ended_utc=$ended" >> "$log"
		echo "END_UTC=$ended" >> "$log"
		;;
	smoke)
		if [ -z "${E1_SMOKE_CMD:-}" ]; then
			echo "error: E1_SMOKE_CMD is required, for example: ssh root@TARGET /usr/bin/e1-mmio-smoke" >&2
			exit 2
		fi
		record_command \
			e1-mmio-smoke \
			"$evidence_dir/e1-mmio-smoke.log" \
			"$E1_SMOKE_CMD"
		;;
	ml-smoke)
		if [ -z "${E1_NPU_ML_SMOKE_CMD:-}" ]; then
			echo "error: E1_NPU_ML_SMOKE_CMD is required, for example: ssh root@TARGET /usr/bin/e1-npu-ml-smoke --device /dev/e1-npu" >&2
			exit 2
		fi
		record_command \
			e1-npu-ml-smoke \
			"$evidence_dir/e1-npu-ml-smoke.log" \
			"$E1_NPU_ML_SMOKE_CMD"
		;;
	*)
		echo "error: unknown mode $mode" >&2
		exit 2
		;;
esac
