#!/usr/bin/env sh
set -eu

check_only=0

if [ "${1:-}" = "--check" ]; then
	check_only=1
	shift
fi

if [ "$#" -ne 1 ]; then
	echo "usage: $0 [--check] /path/to/buildroot" >&2
	exit 2
fi

buildroot=$1
repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/../../.." && pwd)
external="$repo_root/sw/buildroot"

if [ ! -f "$buildroot/Makefile" ] || [ ! -d "$buildroot/configs" ]; then
	echo "error: $buildroot does not look like a Buildroot checkout" >&2
	exit 1
fi

if [ ! -f "$external/external.desc" ] || [ ! -f "$external/Config.in" ] || [ ! -f "$external/external.mk" ]; then
	echo "error: missing BR2_EXTERNAL metadata under $external" >&2
	exit 1
fi

printf 'Run from the Buildroot checkout:\n'
printf '  make BR2_EXTERNAL=%s eliza_e1_defconfig\n' "$external"
printf '  make BR2_EXTERNAL=%s\n' "$external"
printf 'Capture real evidence back in this repository:\n'
printf '  %s/sw/buildroot/scripts/capture-buildroot-evidence.sh %s defconfig\n' "$repo_root" "$buildroot"
printf '  (cd %s && make BR2_EXTERNAL=%s)\n' "$buildroot" "$external"
printf '  %s/sw/buildroot/scripts/capture-buildroot-evidence.sh %s image-manifest\n' "$repo_root" "$buildroot"
printf '  E1_SMOKE_CMD='\''ssh root@TARGET /usr/bin/e1-mmio-smoke'\'' %s/sw/buildroot/scripts/capture-buildroot-evidence.sh %s smoke\n' "$repo_root" "$buildroot"
printf '  E1_NPU_ML_SMOKE_CMD='\''ssh root@TARGET /usr/bin/e1-npu-ml-smoke --device /dev/e1-npu'\'' %s/sw/buildroot/scripts/capture-buildroot-evidence.sh %s ml-smoke\n' "$repo_root" "$buildroot"

if [ "$check_only" -eq 1 ]; then
	missing=0
	for path in \
		"$external/configs/eliza_e1_defconfig" \
		"$external/board/eliza/e1/linux.fragment" \
		"$external/board/eliza/e1/rootfs_overlay/usr/bin/e1-mmio-smoke" \
		"$external/package/e1-mmio-smoke/e1-mmio-smoke.mk" \
		"$external/package/e1-npu-ml-smoke/e1-npu-ml-smoke.mk" \
		"$external/package/e1-npu-ml-smoke/src/e1-npu-ml-smoke.c"; do
		if [ ! -f "$path" ]; then
				echo "FAIL: missing repo artifact ${path#"$repo_root"/}" >&2
			missing=1
		fi
	done
	if [ ! -f "$external/../linux-external.tar.xz" ]; then
		echo "STATUS: BLOCKED buildroot.import-check - missing external kernel tarball ${external#"$repo_root"/}/../linux-external.tar.xz"
		exit 2
	fi
	if [ "$missing" -ne 0 ]; then
		exit 1
	fi
	echo "STATUS: PASS buildroot.import-check - external Buildroot checkout shape, BR2_EXTERNAL inputs, and kernel tarball are present"
	echo "STATUS: BLOCKED buildroot.runtime-evidence - run external Buildroot build and archive docs/evidence/buildroot/*.log"
fi
