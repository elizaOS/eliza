#!/usr/bin/env sh
set -eu

check_only=0
dry_run=0

while [ "$#" -gt 0 ]; do
	case "${1:-}" in
		--check)
			check_only=1
			shift
			;;
		--dry-run)
			dry_run=1
			shift
			;;
		--help|-h)
			echo "usage: $0 [--check] [--dry-run] /path/to/aosp" >&2
			exit 0
			;;
		--)
			shift
			break
			;;
		-*)
			echo "error: unknown option $1" >&2
			exit 2
			;;
		*)
			break
			;;
	esac
done

if [ "$#" -ne 1 ]; then
	echo "usage: $0 [--check] [--dry-run] /path/to/aosp" >&2
	exit 2
fi

aosp=$1
repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)
device_src="$repo_root/sw/aosp-device/device/eliza/eliza_ai_soc"
device_dst="$aosp/device/eliza/eliza_ai_soc"
manifest_src="$repo_root/sw/aosp-device/manifests/eliza-ai-soc-local.xml"

if [ ! -f "$aosp/build/envsetup.sh" ] || [ ! -d "$aosp/device" ]; then
	echo "error: $aosp does not look like an AOSP checkout" >&2
	exit 1
fi

required_repo_artifacts="
$device_src/AndroidProducts.mk
$device_src/eliza_ai_soc.mk
$device_src/BoardConfig.mk
$device_src/device.mk
$device_src/init.eliza.rc
$device_src/fstab.eliza
$device_src/manifest.xml
$device_src/eliza_e1.xml
$device_src/device_framework_matrix.xml
$device_src/kernel/eliza_ai_soc.fragment
$device_src/dts/eliza-e1-android.dts
$device_src/sepolicy/file_contexts
$device_src/sepolicy/e1_npu.te
$device_src/hal/e1_npu/Android.bp
$device_src/hal/hwcomposer/Android.bp
$manifest_src
"

missing=0
for path in $required_repo_artifacts; do
	if [ ! -f "$path" ]; then
			echo "FAIL: missing repo artifact ${path#"$repo_root"/}" >&2
		missing=1
	fi
done
if [ "$missing" -ne 0 ]; then
	exit 1
fi

if [ "$dry_run" -eq 1 ]; then
	echo "DRY-RUN: would sync ${device_src#"$repo_root"/} -> $device_dst"
	echo "DRY-RUN: would preserve external AOSP checkout outside device/eliza/eliza_ai_soc"
fi

if [ "$check_only" -eq 0 ] && [ "$dry_run" -eq 0 ]; then
	mkdir -p "$aosp/device/eliza"
	rsync -a --delete "$device_src/" "$device_dst/"
fi

if [ "$check_only" -eq 1 ]; then
	if [ -d "$device_dst" ]; then
		for rel in AndroidProducts.mk eliza_ai_soc.mk BoardConfig.mk device.mk init.eliza.rc fstab.eliza manifest.xml eliza_e1.xml device_framework_matrix.xml kernel/eliza_ai_soc.fragment dts/eliza-e1-android.dts sepolicy/file_contexts sepolicy/e1_npu.te hal/e1_npu/Android.bp hal/hwcomposer/Android.bp; do
			if [ ! -f "$device_dst/$rel" ]; then
				echo "FAIL: imported AOSP tree missing device/eliza/eliza_ai_soc/$rel" >&2
				missing=1
			fi
		done
		if [ "$missing" -ne 0 ]; then
			exit 1
		fi
	else
		echo "STATUS: BLOCKED aosp.imported-tree - $device_dst is not present; run without --check to import"
	fi
	echo "STATUS: PASS aosp.import-check - external AOSP checkout shape and repo device inputs are present"
	echo "STATUS: BLOCKED aosp.build-evidence - run lunch/vendorimage/checkvintf and archive docs/evidence/android/*.log"
elif [ "$dry_run" -eq 1 ]; then
	echo "STATUS: PASS aosp.import-dry-run - checkout shape and repo device inputs are present"
else
	printf 'Imported Eliza AOSP device tree.\n'
fi
printf 'Validate from the AOSP checkout:\n'
printf '  source build/envsetup.sh\n'
printf '  lunch eliza_ai_soc-trunk_staging-userdebug\n'
printf '  m nothing\n'
printf '  m vendorimage\n'
printf '  checkvintf against out/target/product/eliza_ai_soc vendor artifacts\n'
printf 'Capture real evidence back in this repository:\n'
# shellcheck disable=SC2016
printf '  { printf "EXTERNAL_TREE=%s\\nCOMMAND=source build/envsetup.sh && lunch eliza_ai_soc-trunk_staging-userdebug\\nSTART_UTC=$(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ)\\n"; . build/envsetup.sh && lunch eliza_ai_soc-trunk_staging-userdebug; rc=$?; printf "END_UTC=$(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ)\\nRESULT=$rc\\n"; exit $rc; } 2>&1 | tee %s/docs/evidence/android/eliza_ai_soc_lunch.log\n' "$aosp" "$repo_root"
# shellcheck disable=SC2016
printf '  { printf "EXTERNAL_TREE=%s\\nCOMMAND=m vendorimage\\nSTART_UTC=$(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ)\\n"; m vendorimage; rc=$?; find out/target/product/eliza_ai_soc -path "*vendor.eliza.e1_npu@1.0-service" -o -path "*hwcomposer.eliza_ai_soc"; printf "END_UTC=$(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ)\\nRESULT=$rc\\n"; exit $rc; } 2>&1 | tee %s/docs/evidence/android/eliza_ai_soc_vendorimage.log\n' "$aosp" "$repo_root"
printf '  Use docs/android/boot-transcript.schema.json sidecars for Cuttlefish, QEMU, and Renode boot transcripts.\n'
printf 'This helper does not build Android, launch Cuttlefish, or prove boot.\n'
