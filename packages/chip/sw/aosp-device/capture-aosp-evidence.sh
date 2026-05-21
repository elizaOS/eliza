#!/usr/bin/env sh
# shellcheck disable=SC2016
set -eu

usage() {
	echo "usage: $0 /path/to/aosp {lunch|vendorimage|checkvintf|sepolicy-build|selinux-neverallow|cts-vts-plan|cuttlefish-smoke|cuttlefish-agent-smoke|cuttlefish-boot-full|cvd-hal-smoke|qemu-smoke|renode-smoke|cuttlefish-boot|cts-subset|vts-subset}" >&2
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
aosp_cuttlefish_product=${AOSP_CUTTLEFISH_PRODUCT:-aosp_cf_riscv64_phone-trunk_staging-userdebug}
aosp_target_product=${AOSP_TARGET_PRODUCT:-eliza_ai_soc}
aosp_make_args=${AOSP_MAKE_ARGS:-}
aosp_cuttlefish_args=${AOSP_CUTTLEFISH_ARGS:---cpus=4 --memory_mb=8192 --gpu_mode=none}
aosp_cuttlefish_launcher=${AOSP_CUTTLEFISH_LAUNCHER:-}
aosp_adb_timeout_seconds=${AOSP_ADB_TIMEOUT_SECONDS:-180}
aosp_adb_serial=${AOSP_ADB_SERIAL:-}
aosp_cts_vts_excluded_modules=${AOSP_CTS_VTS_EXCLUDED_MODULES:-full_cts,full_vts,device_compatibility_claims}
aosp_cts_vts_result_dir=${AOSP_CTS_VTS_RESULT_DIR:-out/host/linux-x86/cts-vts-plan}
aosp_cts_vts_plan_command=${AOSP_CTS_VTS_PLAN_COMMAND:-}
aosp_qemu_smoke_command=${AOSP_QEMU_SMOKE_COMMAND:-}
aosp_renode_smoke_command=${AOSP_RENODE_SMOKE_COMMAND:-}
aosp_agent_apk=${AOSP_AGENT_APK:-}
aosp_agent_package=${AOSP_AGENT_PACKAGE:-ai.elizaos.app}
aosp_agent_service=${AOSP_AGENT_SERVICE:-ai.elizaos.app/.ElizaAgentService}
aosp_agent_host_port=${AOSP_AGENT_HOST_PORT:-31337}
aosp_agent_device_port=${AOSP_AGENT_DEVICE_PORT:-31337}
aosp_agent_service_wait_seconds=${AOSP_AGENT_SERVICE_WAIT_SECONDS:-90}
aosp_agent_port_wait_seconds=${AOSP_AGENT_PORT_WAIT_SECONDS:-60}
aosp_agent_llama_model=${AOSP_AGENT_LLAMA_MODEL:-}
aosp_agent_llama_device_dir=${AOSP_AGENT_LLAMA_DEVICE_DIR:-/data/local/tmp/eliza-smoke}
aosp_agent_llama_prompt=${AOSP_AGENT_LLAMA_PROMPT:-Say hello in one short sentence.}
aosp_agent_llama_min_tokens=${AOSP_AGENT_LLAMA_MIN_TOKENS:-32}
aosp_agent_tts_text=${AOSP_AGENT_TTS_TEXT:-The quick brown fox jumps over the lazy dog.}
aosp_agent_golden_audio=${AOSP_AGENT_GOLDEN_AUDIO:-}
aosp_agent_golden_transcript=${AOSP_AGENT_GOLDEN_TRANSCRIPT:-}
aosp_agent_stt_min_overlap=${AOSP_AGENT_STT_MIN_OVERLAP:-0.80}
aosp_agent_sd_optin=${AOSP_AGENT_SD_OPTIN:-0}
aosp_agent_sd_prompt=${AOSP_AGENT_SD_PROMPT:-a single red apple on a white background}
aosp_cuttlefish_boot_cpus=${AOSP_CUTTLEFISH_BOOT_CPUS:-8}
aosp_cuttlefish_boot_memory_mb=${AOSP_CUTTLEFISH_BOOT_MEMORY_MB:-12288}
aosp_cuttlefish_boot_gpu_mode=${AOSP_CUTTLEFISH_BOOT_GPU_MODE:-none}
aosp_cuttlefish_boot_timeout_seconds=${AOSP_CUTTLEFISH_BOOT_TIMEOUT_SECONDS:-1800}
aosp_cuttlefish_boot_manifest=${AOSP_CUTTLEFISH_BOOT_MANIFEST:-}
aosp_cuttlefish_boot_clean=${AOSP_CUTTLEFISH_BOOT_CLEAN:-0}
launch_cuttlefish_driver="$repo_root/sw/aosp-device/launch-cuttlefish-riscv64.sh"
cuttlefish_boot_gate="$repo_root/sw/aosp-device/cuttlefish-boot-gate.sh"
agent_smoke_driver="$repo_root/sw/aosp-device/scripts/cuttlefish_agent_smoke.py"
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
		# Runs checkvintf --check-one then checkvintf --check-compat
		# against the built vendor + system images so the HAL surface
		# declared in eliza_e1.xml is matched against the framework
		# matrix. Emits VINTF_COMPAT=ok only when --check-compat exits 0.
		run_capture \
			eliza_ai_soc_checkvintf \
			"$evidence_dir/eliza_ai_soc_checkvintf.log" \
			"checkvintf --check-compat" \
			compat_only \
			env AOSP_PRODUCT="$aosp_product" AOSP_TARGET_PRODUCT="$aosp_target_product" AOSP_MAKE_ARGS="$aosp_make_args" "$aosp_shell" -lc '
				source build/envsetup.sh &&
				lunch "$AOSP_PRODUCT" >/dev/null &&
				m ${AOSP_MAKE_ARGS:-} checkvintf framework_compatibility_matrix.device.xml >/dev/null &&
				product_out="out/target/product/$AOSP_TARGET_PRODUCT" &&
				manifest=$(find "$product_out/vendor/etc/vintf" \( -name eliza_e1.xml -o -name manifest.xml \) -print -quit 2>/dev/null) &&
				echo "TARGET_PRODUCT=$AOSP_TARGET_PRODUCT" &&
				echo "eliza_e1.xml=$manifest" &&
				[ -n "$manifest" ] &&
				checkvintf_bin=out/host/linux-x86/bin/checkvintf &&
				[ -x "$checkvintf_bin" ] &&
				echo "--- checkvintf --check-one ---" &&
				"$checkvintf_bin" --check-one --dirmap /vendor:"$product_out/vendor" &&
				echo "--- checkvintf --check-compat ---" &&
				"$checkvintf_bin" --check-compat \
					--dirmap /system:"$product_out/system" \
					--dirmap /vendor:"$product_out/vendor" \
					--dirmap /odm:"$product_out/odm" \
					--dirmap /product:"$product_out/product" \
					--dirmap /system_ext:"$product_out/system_ext" \
					--dirmap /apex:"$product_out/apex" &&
				echo "VINTF_COMPAT=ok"
			'
		;;
	sepolicy-build)
		# shellcheck disable=SC2016
		# Builds vendor_sepolicy.cil, selinux_policy, and
		# sepolicy_neverallows so the log proves the policy compiled
		# the HAL types. Emits SEPOLICY_BUILD=ok on RESULT=0.
		run_capture \
			eliza_ai_soc_sepolicy_build \
			"$evidence_dir/eliza_ai_soc_sepolicy_build.log" \
			"m vendor_sepolicy.cil selinux_policy sepolicy_neverallows" \
			compat_only \
			env AOSP_PRODUCT="$aosp_product" AOSP_TARGET_PRODUCT="$aosp_target_product" AOSP_MAKE_ARGS="$aosp_make_args" "$aosp_shell" -lc '
				source build/envsetup.sh &&
				lunch "$AOSP_PRODUCT" >/dev/null &&
				m ${AOSP_MAKE_ARGS:-} vendor_sepolicy.cil selinux_policy sepolicy_neverallows &&
				product_out="out/target/product/$AOSP_TARGET_PRODUCT" &&
				echo "SEPOLICY_TARGETS=vendor_sepolicy.cil selinux_policy sepolicy_neverallows" &&
				find "$product_out" -name vendor_sepolicy.cil -o -name selinux_policy 2>/dev/null &&
				grep -R -n -I "e1_npu_device" device/eliza "$product_out/vendor/etc/selinux" "$product_out/obj/ETC/vendor_sepolicy.cil_intermediates" 2>/dev/null &&
				grep -R -n -I "hal_e1_npu_default" device/eliza "$product_out/vendor/etc/selinux" "$product_out/obj/ETC/vendor_sepolicy.cil_intermediates" 2>/dev/null &&
				echo "SEPOLICY_BUILD=ok"
			'
		;;
	selinux-neverallow)
		# shellcheck disable=SC2016
		# Standalone neverallow run. Records SEPOLICY_NEVERALLOW=ok when
		# the build succeeds, which only happens if no neverallow rule
		# fired against the e1_npu HAL types.
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
				grep -R -n -I "e1_npu" device/eliza "$product_out/vendor/etc/selinux" "$product_out/obj/ETC/vendor_sepolicy.cil_intermediates" 2>/dev/null &&
				echo "SEPOLICY_NEVERALLOW=ok"
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
				"source build/envsetup.sh && lunch $aosp_cuttlefish_product && launch_cvd $aosp_cuttlefish_args -daemon" \
				smoke \
				env AOSP_PRODUCT="$aosp_cuttlefish_product" AOSP_TARGET_PRODUCT="$aosp_target_product" AOSP_CUTTLEFISH_ARGS="$aosp_cuttlefish_args" AOSP_CUTTLEFISH_LAUNCHER="$aosp_cuttlefish_launcher" AOSP_ADB_SERIAL="$aosp_adb_serial" "$aosp_shell" -lc '
					source build/envsetup.sh &&
					lunch "$AOSP_PRODUCT" >/dev/null &&
				cleanup() { stop_cvd >/dev/null 2>&1 || cvd stop >/dev/null 2>&1 || true; } &&
				adb_cvd() {
					if [ -n "$AOSP_ADB_SERIAL" ]; then
						adb -s "$AOSP_ADB_SERIAL" "$@"
					else
						adb "$@"
					fi
				} &&
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
					cvd_host_arg=
					cvd_product_arg=
					if [ -d /usr/lib/cuttlefish-common/bin ]; then
						cvd_host_arg="--host_path=/usr/lib/cuttlefish-common/bin"
					fi
					if [ -n "${ANDROID_PRODUCT_OUT:-}" ] && [ -d "$ANDROID_PRODUCT_OUT" ]; then
						cvd_product_arg="--product_path=$ANDROID_PRODUCT_OUT"
					fi
					cvd create ${cvd_host_arg:-} ${cvd_product_arg:-} $AOSP_CUTTLEFISH_ARGS --daemon
				else
					"$cuttlefish_launcher" $AOSP_CUTTLEFISH_ARGS -daemon
				fi &&
				if [ -z "$AOSP_ADB_SERIAL" ]; then
					AOSP_ADB_SERIAL=$(adb devices -l | grep -v " usb:" | sed -n "2{s/[[:space:]].*//;p;q;}") &&
					[ -n "$AOSP_ADB_SERIAL" ] && echo "ADB_SERIAL=$AOSP_ADB_SERIAL"
				fi &&
				deadline=$((SECONDS + '"$aosp_adb_timeout_seconds"')) &&
				until adb_cvd get-state >/dev/null 2>&1; do
					if [ "$SECONDS" -ge "$deadline" ]; then
						echo "eliza-evidence: adb_wait_timeout_seconds='"$aosp_adb_timeout_seconds"'" &&
						exit 1
					fi
					sleep 2
				done &&
				echo "adb shell true" &&
				adb_cvd shell true &&
				echo "adb shell getprop ro.product.cpu.abi" &&
				abi=$(adb_cvd shell getprop ro.product.cpu.abi | tr -d "\r") &&
				echo "ro.product.cpu.abi=$abi" &&
				echo "TARGET_PRODUCT=$AOSP_TARGET_PRODUCT" &&
				echo "adb shell getprop sys.boot_completed" &&
				boot= &&
				while [ "$SECONDS" -lt "$deadline" ]; do
					boot=$(adb_cvd shell getprop sys.boot_completed | tr -d "\r") &&
					[ "$boot" = 1 ] && break
					sleep 2
				done &&
				echo "sys.boot_completed=$boot" &&
				mkdir -p out &&
				adb_cvd shell logcat -d -b all > out/eliza-cuttlefish-boot-logcat.txt 2>/dev/null || true
				[ "$abi" = riscv64 ] && [ "$boot" = 1 ]
			'
		;;
	cuttlefish-agent-smoke)
		# shellcheck disable=SC2016
		if [ -z "$aosp_agent_apk" ]; then
			echo "error: set AOSP_AGENT_APK to the riscv64 Eliza agent APK path" >&2
			exit 2
		fi
		if [ -z "$aosp_agent_llama_model" ]; then
			echo "error: set AOSP_AGENT_LLAMA_MODEL to a GGUF file path for the llama smoke" >&2
			exit 2
		fi
		if [ -z "$aosp_agent_golden_audio" ]; then
			echo "error: set AOSP_AGENT_GOLDEN_AUDIO to a WAV path for the whisper smoke" >&2
			exit 2
		fi
		if [ -z "$aosp_agent_golden_transcript" ]; then
			echo "error: set AOSP_AGENT_GOLDEN_TRANSCRIPT to the golden transcript text for the whisper smoke" >&2
			exit 2
		fi
		if [ ! -x "$agent_smoke_driver" ]; then
			echo "error: agent smoke driver missing: $agent_smoke_driver" >&2
			exit 1
		fi
		command_label="cuttlefish_agent_smoke.py against $aosp_agent_service via tcp:$aosp_agent_host_port"
		run_capture \
			eliza_ai_soc_cuttlefish_agent_smoke \
			"$evidence_dir/eliza_ai_soc_cuttlefish_agent_smoke.log" \
			"$command_label" \
			smoke \
			env AOSP_PRODUCT="$aosp_product" \
				AOSP_TARGET_PRODUCT="$aosp_target_product" \
				AOSP_ADB_SERIAL="$aosp_adb_serial" \
				AOSP_AGENT_APK="$aosp_agent_apk" \
				AOSP_AGENT_PACKAGE="$aosp_agent_package" \
				AOSP_AGENT_SERVICE="$aosp_agent_service" \
				AOSP_AGENT_HOST_PORT="$aosp_agent_host_port" \
				AOSP_AGENT_DEVICE_PORT="$aosp_agent_device_port" \
				AOSP_AGENT_SERVICE_WAIT_SECONDS="$aosp_agent_service_wait_seconds" \
				AOSP_AGENT_PORT_WAIT_SECONDS="$aosp_agent_port_wait_seconds" \
				AOSP_AGENT_LLAMA_MODEL="$aosp_agent_llama_model" \
				AOSP_AGENT_LLAMA_DEVICE_DIR="$aosp_agent_llama_device_dir" \
				AOSP_AGENT_LLAMA_PROMPT="$aosp_agent_llama_prompt" \
				AOSP_AGENT_LLAMA_MIN_TOKENS="$aosp_agent_llama_min_tokens" \
				AOSP_AGENT_TTS_TEXT="$aosp_agent_tts_text" \
				AOSP_AGENT_GOLDEN_AUDIO="$aosp_agent_golden_audio" \
				AOSP_AGENT_GOLDEN_TRANSCRIPT="$aosp_agent_golden_transcript" \
				AOSP_AGENT_STT_MIN_OVERLAP="$aosp_agent_stt_min_overlap" \
				AOSP_AGENT_SD_OPTIN="$aosp_agent_sd_optin" \
				AOSP_AGENT_SD_PROMPT="$aosp_agent_sd_prompt" \
				AGENT_SMOKE_DRIVER="$agent_smoke_driver" \
				"$aosp_shell" -lc '
					if ! command -v adb >/dev/null 2>&1; then
						echo "error: adb is not on PATH; source build/envsetup.sh in the AOSP tree first" >&2
						exit 1
					fi &&
					if [ -n "${AOSP_ADB_SERIAL:-}" ]; then
						adb -s "$AOSP_ADB_SERIAL" get-state >/dev/null
					else
						adb get-state >/dev/null
					fi &&
					mkdir -p out &&
					python3 "$AGENT_SMOKE_DRIVER" --out-dir out
				'
		;;
	cuttlefish-boot-full)
		# shellcheck disable=SC2016
		if [ ! -x "$launch_cuttlefish_driver" ]; then
			echo "error: launch driver missing: $launch_cuttlefish_driver" >&2
			exit 1
		fi
		if [ ! -x "$cuttlefish_boot_gate" ]; then
			echo "error: boot gate missing: $cuttlefish_boot_gate" >&2
			exit 1
		fi
		command_label="launch-cuttlefish-riscv64.sh --cpus=$aosp_cuttlefish_boot_cpus --memory-mb=$aosp_cuttlefish_boot_memory_mb --gpu-mode=$aosp_cuttlefish_boot_gpu_mode && cuttlefish-boot-gate.sh"
		run_capture \
			cuttlefish_riscv64_boot \
			"$evidence_dir/cuttlefish_riscv64_boot.log" \
			"$command_label" \
			smoke \
			env AOSP_PRODUCT="$aosp_product" \
				AOSP_TARGET_PRODUCT="$aosp_target_product" \
				AOSP_ADB_SERIAL="$aosp_adb_serial" \
				AOSP_AGENT_PACKAGE="$aosp_agent_package" \
				AOSP_AGENT_SERVICE="$aosp_agent_service" \
				AOSP_AGENT_HOST_PORT="$aosp_agent_host_port" \
				AOSP_AGENT_DEVICE_PORT="$aosp_agent_device_port" \
				AOSP_CUTTLEFISH_BOOT_CPUS="$aosp_cuttlefish_boot_cpus" \
				AOSP_CUTTLEFISH_BOOT_MEMORY_MB="$aosp_cuttlefish_boot_memory_mb" \
				AOSP_CUTTLEFISH_BOOT_GPU_MODE="$aosp_cuttlefish_boot_gpu_mode" \
				AOSP_CUTTLEFISH_BOOT_TIMEOUT_SECONDS="$aosp_cuttlefish_boot_timeout_seconds" \
				AOSP_CUTTLEFISH_BOOT_MANIFEST="$aosp_cuttlefish_boot_manifest" \
				AOSP_CUTTLEFISH_BOOT_CLEAN="$aosp_cuttlefish_boot_clean" \
				LAUNCH_DRIVER="$launch_cuttlefish_driver" \
				BOOT_GATE="$cuttlefish_boot_gate" \
				AOSP_DIR="$aosp" \
				"$aosp_shell" -lc '
					source build/envsetup.sh &&
					lunch "$AOSP_PRODUCT" >/dev/null &&
					clean_flag= &&
					if [ "$AOSP_CUTTLEFISH_BOOT_CLEAN" = 1 ]; then
						clean_flag=--clean
					fi &&
					"$LAUNCH_DRIVER" \
						$clean_flag \
						"--cpus=$AOSP_CUTTLEFISH_BOOT_CPUS" \
						"--memory-mb=$AOSP_CUTTLEFISH_BOOT_MEMORY_MB" \
						"--gpu-mode=$AOSP_CUTTLEFISH_BOOT_GPU_MODE" \
						"--boot-timeout-seconds=$AOSP_CUTTLEFISH_BOOT_TIMEOUT_SECONDS" \
						"--aosp=$AOSP_DIR" &&
					gate_tmp=$(mktemp) &&
					gate_args="--out=$gate_tmp --agent-package=$AOSP_AGENT_PACKAGE --agent-service=$AOSP_AGENT_SERVICE --agent-host-port=$AOSP_AGENT_HOST_PORT --agent-device-port=$AOSP_AGENT_DEVICE_PORT" &&
					if [ -n "${AOSP_ADB_SERIAL:-}" ]; then
						gate_args="$gate_args --adb-serial=$AOSP_ADB_SERIAL"
					fi &&
					if [ -n "${AOSP_CUTTLEFISH_BOOT_MANIFEST:-}" ]; then
						gate_args="$gate_args --manifest=$AOSP_CUTTLEFISH_BOOT_MANIFEST"
					fi &&
					"$BOOT_GATE" $gate_args
					gate_rc=$?
					cat "$gate_tmp"
					rm -f "$gate_tmp"
					[ "$gate_rc" -eq 0 ]
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
	cvd-hal-smoke)
		# Delegates to sw/aosp-device/check-cvd-hal-smoke.sh which
		# boots Cuttlefish riscv64, runs adb shell lshal -i, and
		# asserts vendor.eliza.e1_npu@1.0::IE1Npu/default is registered
		# and INTERFACE_AVAILABLE. The driver script owns the evidence
		# transcript layout and provenance markers.
		exec env AOSP_PRODUCT="$aosp_cuttlefish_product" \
			AOSP_SHELL="$aosp_shell" \
			AOSP_CUTTLEFISH_ARGS="$aosp_cuttlefish_args" \
			AOSP_CUTTLEFISH_LAUNCHER="$aosp_cuttlefish_launcher" \
			AOSP_ADB_TIMEOUT_SECONDS="$aosp_adb_timeout_seconds" \
			AOSP_ADB_SERIAL="$aosp_adb_serial" \
			"$repo_root/sw/aosp-device/check-cvd-hal-smoke.sh" "$aosp"
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
