#!/usr/bin/env sh
# shellcheck disable=SC2016
set -eu

usage() {
	echo "usage: $0 /path/to/aosp {lunch|vendorimage|checkvintf|sepolicy-build|selinux-neverallow|cts-vts-plan|cuttlefish-smoke|qemu-smoke|renode-smoke|cuttlefish-boot|cts-subset|vts-subset}" >&2
}

if [ "$#" -ne 2 ]; then
	usage
	exit 2
fi

aosp=$1
mode=$2
repo_root=$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)
evidence_dir="$repo_root/docs/evidence/android"
aosp_shell=${AOSP_SHELL:-bash}
aosp_product=${AOSP_PRODUCT:-eliza_ai_soc-trunk_staging-userdebug}
aosp_target_product=${AOSP_TARGET_PRODUCT:-eliza_ai_soc}
aosp_make_args=${AOSP_MAKE_ARGS:-}
aosp_cuttlefish_args=${AOSP_CUTTLEFISH_ARGS:---cpus=4 --memory_mb=8192 --gpu_mode=none}
aosp_cuttlefish_launcher=${AOSP_CUTTLEFISH_LAUNCHER:-}
aosp_adb_timeout_seconds=${AOSP_ADB_TIMEOUT_SECONDS:-180}
aosp_cts_vts_excluded_modules=${AOSP_CTS_VTS_EXCLUDED_MODULES:-full_cts,full_vts,device_compatibility_claims}
aosp_cts_vts_result_dir=${AOSP_CTS_VTS_RESULT_DIR:-out/host/linux-x86/cts-vts-plan}
aosp_cts_vts_plan_command=${AOSP_CTS_VTS_PLAN_COMMAND:-}
aosp_qemu_smoke_command=${AOSP_QEMU_SMOKE_COMMAND:-}
aosp_renode_smoke_command=${AOSP_RENODE_SMOKE_COMMAND:-}
reference_only_boundary=reference_only_not_e1_chip_ap_evidence
virtual_device_boundary=virtual_device_smoke_only_not_boot_or_compatibility_evidence
boot_transcript_schema=docs/android/boot-transcript.schema.json

if [ ! -f "$aosp/build/envsetup.sh" ] || [ ! -d "$aosp/device" ]; then
	echo "error: $aosp does not look like an AOSP checkout" >&2
	exit 1
fi
if ! command -v "$aosp_shell" >/dev/null 2>&1; then
	echo "error: AOSP shell '$aosp_shell' is not available; set AOSP_SHELL=/path/to/bash" >&2
	exit 1
fi

mkdir -p "$evidence_dir"

run_capture() {
	artifact=$1
	out=$2
	command_label=$3
	metadata_kind=$4
	shift 4
	start_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	status=FAIL
	status_file=$(mktemp "${TMPDIR:-/tmp}/capture-aosp-evidence.XXXXXX")
	{
		echo "eliza-evidence: target=aosp artifact=$artifact"
		echo "eliza-evidence: external_tree=$aosp"
		echo "eliza-evidence: command=$command_label"
		echo "EXTERNAL_TREE=$aosp"
		echo "COMMAND=$command_label"
		echo "START_UTC=$start_utc"
		echo "COMPATIBILITY_CLAIM=none"
		case "$metadata_kind" in
			smoke)
				echo "eliza-evidence: claim_boundary=$virtual_device_boundary"
				echo "BOOT_CLAIM=none"
				echo "SCHEMA=$boot_transcript_schema"
				;;
			reference)
				echo "eliza-evidence: claim_boundary=$reference_only_boundary"
				echo "BOOT_CLAIM=none"
				;;
			compat_only)
				;;
			*)
				echo "error: internal invalid metadata kind '$metadata_kind'" >&2
				exit 2
				;;
		esac
		echo "eliza-evidence: started_utc=$start_utc"
		cd "$aosp"
		set +e
		"$@"
		rc=$?
		set -e
		end_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
		if [ "$rc" -eq 0 ]; then
			status=PASS
		fi
		echo "eliza-evidence: ended_utc=$end_utc"
		echo "eliza-evidence: status=$status"
		echo "END_UTC=$end_utc"
		echo "RESULT=$rc"
		echo "$rc" > "$status_file"
		exit "$rc"
	} 2>&1 | tee "$out"
	rc=$(cat "$status_file" 2>/dev/null || echo 1)
	rm -f "$status_file"
	return "$rc"
}

case "$mode" in
	lunch)
		# shellcheck disable=SC2016
		run_capture \
			eliza_ai_soc_lunch \
			"$evidence_dir/eliza_ai_soc_lunch.log" \
			"lunch $aosp_product" \
			compat_only \
			env AOSP_PRODUCT="$aosp_product" "$aosp_shell" -lc 'source build/envsetup.sh && lunch "$AOSP_PRODUCT"'
		;;
	vendorimage)
		# shellcheck disable=SC2016
		run_capture \
			eliza_ai_soc_vendorimage \
			"$evidence_dir/eliza_ai_soc_vendorimage.log" \
			"m vendorimage" \
			compat_only \
			env AOSP_PRODUCT="$aosp_product" AOSP_TARGET_PRODUCT="$aosp_target_product" AOSP_MAKE_ARGS="$aosp_make_args" "$aosp_shell" -lc '
				source build/envsetup.sh &&
				lunch "$AOSP_PRODUCT" >/dev/null &&
				m ${AOSP_MAKE_ARGS:-} vendorimage &&
				product_out="out/target/product/$AOSP_TARGET_PRODUCT" &&
				find "$product_out" -maxdepth 2 \( -name vendor.img -o -name installed-files-vendor.txt \) -print &&
				grep -R -n -I "eliza_e1.xml" device/eliza "$product_out/vendor/etc/vintf" 2>/dev/null &&
				grep -R -n -I "vendor.e1_npu.ready=0" device/eliza "$product_out/vendor/build.prop" "$product_out/vendor/etc/init" 2>/dev/null
			'
		;;
	checkvintf)
		# shellcheck disable=SC2016
		run_capture \
			eliza_ai_soc_checkvintf \
			"$evidence_dir/eliza_ai_soc_checkvintf.log" \
			"checkvintf eliza_ai_soc" \
			compat_only \
			env AOSP_PRODUCT="$aosp_product" AOSP_TARGET_PRODUCT="$aosp_target_product" AOSP_MAKE_ARGS="$aosp_make_args" "$aosp_shell" -lc '
				source build/envsetup.sh &&
				lunch "$AOSP_PRODUCT" >/dev/null &&
				m ${AOSP_MAKE_ARGS:-} checkvintf >/dev/null &&
				product_out="out/target/product/$AOSP_TARGET_PRODUCT" &&
				manifest=$(find "$product_out/vendor/etc/vintf" \( -name eliza_e1.xml -o -name manifest.xml \) -print -quit 2>/dev/null) &&
				echo "TARGET_PRODUCT=$AOSP_TARGET_PRODUCT" &&
				echo "eliza_e1.xml=$manifest" &&
				[ -n "$manifest" ] &&
				checkvintf_bin=out/host/linux-x86/bin/checkvintf &&
				[ -x "$checkvintf_bin" ] &&
				"$checkvintf_bin" --check-one --dirmap /vendor:"$product_out/vendor"
			'
		;;
	sepolicy-build)
		# shellcheck disable=SC2016
		run_capture \
			eliza_ai_soc_sepolicy_build \
			"$evidence_dir/eliza_ai_soc_sepolicy_build.log" \
			"m vendor_sepolicy.cil selinux_policy" \
			compat_only \
			env AOSP_PRODUCT="$aosp_product" AOSP_TARGET_PRODUCT="$aosp_target_product" AOSP_MAKE_ARGS="$aosp_make_args" "$aosp_shell" -lc '
				source build/envsetup.sh &&
				lunch "$AOSP_PRODUCT" >/dev/null &&
				m ${AOSP_MAKE_ARGS:-} vendor_sepolicy.cil selinux_policy &&
				product_out="out/target/product/$AOSP_TARGET_PRODUCT" &&
				echo "SEPOLICY_TARGETS=vendor_sepolicy.cil selinux_policy" &&
				find "$product_out" -name vendor_sepolicy.cil -o -name selinux_policy 2>/dev/null &&
				grep -R -n -I "e1_npu_device" device/eliza "$product_out/vendor/etc/selinux" "$product_out/obj/ETC/vendor_sepolicy.cil_intermediates" 2>/dev/null &&
				grep -R -n -I "hal_e1_npu_default" device/eliza "$product_out/vendor/etc/selinux" "$product_out/obj/ETC/vendor_sepolicy.cil_intermediates" 2>/dev/null
			'
		;;
	selinux-neverallow)
		# shellcheck disable=SC2016
		run_capture \
			eliza_ai_soc_selinux_neverallow \
			"$evidence_dir/eliza_ai_soc_selinux_neverallow.log" \
			"m sepolicy_neverallows" \
			compat_only \
			env AOSP_PRODUCT="$aosp_product" AOSP_TARGET_PRODUCT="$aosp_target_product" AOSP_MAKE_ARGS="$aosp_make_args" "$aosp_shell" -lc '
				source build/envsetup.sh &&
				lunch "$AOSP_PRODUCT" >/dev/null &&
				m ${AOSP_MAKE_ARGS:-} sepolicy_neverallows &&
				product_out="out/target/product/$AOSP_TARGET_PRODUCT" &&
				echo "SEPOLICY_TARGET=sepolicy_neverallows" &&
				grep -R -n -I "e1_npu" device/eliza "$product_out/vendor/etc/selinux" "$product_out/obj/ETC/vendor_sepolicy.cil_intermediates" 2>/dev/null
			'
		;;
	cts-vts-plan)
		# shellcheck disable=SC2016
		command_label="m cts vts && cts-tradefed list modules && vts-tradefed list modules"
		if [ -n "$aosp_cts_vts_plan_command" ]; then
			command_label=$aosp_cts_vts_plan_command
		fi
		run_capture \
			eliza_ai_soc_cts_vts_plan \
			"$evidence_dir/eliza_ai_soc_cts_vts_plan.log" \
			"$command_label" \
			compat_only \
			env AOSP_PRODUCT="$aosp_product" \
				AOSP_CTS_VTS_EXCLUDED_MODULES="$aosp_cts_vts_excluded_modules" \
				AOSP_CTS_VTS_RESULT_DIR="$aosp_cts_vts_result_dir" \
				AOSP_CTS_VTS_PLAN_COMMAND="$aosp_cts_vts_plan_command" \
				"$aosp_shell" -lc '
					source build/envsetup.sh &&
					lunch "$AOSP_PRODUCT" >/dev/null &&
					echo "CTS_SCOPE=smoke_only" &&
					echo "VTS_SCOPE=vintf_selinux_hal_manager_only" &&
					echo "EXCLUDED_MODULES=$AOSP_CTS_VTS_EXCLUDED_MODULES" &&
					echo "RESULT_DIR=$AOSP_CTS_VTS_RESULT_DIR" &&
					if [ -n "$AOSP_CTS_VTS_PLAN_COMMAND" ]; then
						eval "$AOSP_CTS_VTS_PLAN_COMMAND"
					else
						m cts vts &&
						echo "cts-tradefed list modules" &&
						if command -v cts-tradefed >/dev/null 2>&1; then
							cts-tradefed list modules
						elif [ -x out/host/linux-x86/cts/android-cts/tools/cts-tradefed ]; then
							out/host/linux-x86/cts/android-cts/tools/cts-tradefed list modules
						else
							echo "error: cts-tradefed unavailable after cts build" >&2
							exit 1
						fi &&
						echo "vts-tradefed list modules" &&
						if command -v vts-tradefed >/dev/null 2>&1; then
							vts-tradefed list modules
						elif [ -x out/host/linux-x86/vts/android-vts/tools/vts-tradefed ]; then
							out/host/linux-x86/vts/android-vts/tools/vts-tradefed list modules
						else
							echo "error: vts-tradefed unavailable after vts build" >&2
							exit 1
						fi
					fi
				'
		;;
	cuttlefish-smoke|cuttlefish-boot)
		# shellcheck disable=SC2016
		run_capture \
			cuttlefish_riscv64_smoke \
			"$evidence_dir/cuttlefish_riscv64_smoke.log" \
			"source build/envsetup.sh && lunch $aosp_product && launch_cvd $aosp_cuttlefish_args -daemon" \
			smoke \
			env AOSP_PRODUCT="$aosp_product" AOSP_TARGET_PRODUCT="$aosp_target_product" AOSP_CUTTLEFISH_ARGS="$aosp_cuttlefish_args" AOSP_CUTTLEFISH_LAUNCHER="$aosp_cuttlefish_launcher" "$aosp_shell" -lc '
				source build/envsetup.sh &&
				lunch "$AOSP_PRODUCT" >/dev/null &&
				cleanup() { stop_cvd >/dev/null 2>&1 || cvd stop >/dev/null 2>&1 || true; } &&
				trap cleanup EXIT INT TERM &&
				if [ -n "$AOSP_CUTTLEFISH_LAUNCHER" ]; then
					cuttlefish_launcher=$AOSP_CUTTLEFISH_LAUNCHER
				elif command -v launch_cvd >/dev/null 2>&1; then
					cuttlefish_launcher=launch_cvd
				else
					cuttlefish_launcher=cvd
				fi &&
				echo "CUTTLEFISH_LAUNCHER=$cuttlefish_launcher" &&
				if [ "$cuttlefish_launcher" = cvd ]; then
					cvd start $AOSP_CUTTLEFISH_ARGS --daemon
				else
					"$cuttlefish_launcher" $AOSP_CUTTLEFISH_ARGS -daemon
				fi &&
				deadline=$((SECONDS + '"$aosp_adb_timeout_seconds"')) &&
				until adb get-state >/dev/null 2>&1; do
					if [ "$SECONDS" -ge "$deadline" ]; then
						echo "eliza-evidence: adb_wait_timeout_seconds='"$aosp_adb_timeout_seconds"'" &&
						exit 1
					fi
					sleep 2
				done &&
				echo "adb shell true" &&
				adb shell true &&
				echo "adb shell getprop ro.product.cpu.abi" &&
				abi=$(adb shell getprop ro.product.cpu.abi | tr -d "\r") &&
				echo "ro.product.cpu.abi=$abi" &&
				echo "TARGET_PRODUCT=$AOSP_TARGET_PRODUCT" &&
				echo "adb shell getprop sys.boot_completed" &&
				boot= &&
				while [ "$SECONDS" -lt "$deadline" ]; do
					boot=$(adb shell getprop sys.boot_completed | tr -d "\r") &&
					[ "$boot" = 1 ] && break
					sleep 2
				done &&
				echo "sys.boot_completed=$boot" &&
				mkdir -p out &&
				adb shell logcat -d -b all > out/eliza-cuttlefish-boot-logcat.txt 2>/dev/null || true
				[ "$abi" = riscv64 ] && [ "$boot" = 1 ]
			'
		;;
	qemu-smoke)
		# shellcheck disable=SC2016
		command_label=${aosp_qemu_smoke_command:-AOSP_QEMU_SMOKE_COMMAND}
		run_capture \
			qemu_riscv64_smoke \
			"$evidence_dir/qemu_riscv64_smoke.log" \
			"$command_label" \
			smoke \
			env AOSP_PRODUCT="$aosp_product" AOSP_TARGET_PRODUCT="$aosp_target_product" AOSP_QEMU_SMOKE_COMMAND="$aosp_qemu_smoke_command" "$aosp_shell" -lc '
				echo "TARGET_PRODUCT=$AOSP_TARGET_PRODUCT" &&
				if [ -z "$AOSP_QEMU_SMOKE_COMMAND" ]; then
					echo "error: set AOSP_QEMU_SMOKE_COMMAND to the qemu-system-riscv64 smoke command for this checkout" >&2
					exit 2
				fi &&
				eval "$AOSP_QEMU_SMOKE_COMMAND"
			'
		;;
	renode-smoke)
		# shellcheck disable=SC2016
		command_label=${aosp_renode_smoke_command:-AOSP_RENODE_SMOKE_COMMAND}
		run_capture \
			renode_e1_soc_smoke \
			"$evidence_dir/renode_e1_soc_smoke.log" \
			"$command_label" \
			smoke \
			env AOSP_PRODUCT="$aosp_product" AOSP_TARGET_PRODUCT="$aosp_target_product" AOSP_RENODE_SMOKE_COMMAND="$aosp_renode_smoke_command" "$aosp_shell" -lc '
				echo "TARGET_PRODUCT=$AOSP_TARGET_PRODUCT" &&
				if [ -z "$AOSP_RENODE_SMOKE_COMMAND" ]; then
					echo "error: set AOSP_RENODE_SMOKE_COMMAND to the renode smoke command for this checkout" >&2
					exit 2
				fi &&
				eval "$AOSP_RENODE_SMOKE_COMMAND"
			'
		;;
	cts-subset)
		run_capture \
			cts_virtual_device_subset \
			"$evidence_dir/cts_virtual_device_subset.log" \
			"cts-tradefed run commandAndExit cts-virtual-device-subset" \
			reference \
			"$aosp_shell" -lc 'echo "eliza-evidence: compatibility_scope=virtual_device_subset"; cts-tradefed run commandAndExit cts --module CtsOsTestCases --test android.os.cts.BuildTest'
		;;
	vts-subset)
		run_capture \
			vts_virtual_device_subset \
			"$evidence_dir/vts_virtual_device_subset.log" \
			"vts-tradefed run commandAndExit vts-virtual-device-subset" \
			reference \
			"$aosp_shell" -lc 'echo "eliza-evidence: compatibility_scope=virtual_device_subset"; vts-tradefed run commandAndExit vts --module VtsTrebleVintfTest'
		;;
	*)
		usage
		exit 2
		;;
esac
