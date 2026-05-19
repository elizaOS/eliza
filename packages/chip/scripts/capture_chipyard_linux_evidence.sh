#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
raw_dir="$repo_dir/build/evidence/cpu_ap/raw"
generated_manifest="${ELIZA_GENERATED_MANIFEST:-build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json}"
mode="${1:-all}"

usage() {
	printf 'usage: %s [preflight|wire|wire-preflight|plan|all|opensbi-boot|linux-boot|trap-timer-irq|isa-cache-mmu|ap-benchmarks]\n' "$0"
	printf '\n'
	printf 'Set one command env var per capture. Each command must run the generated AP simulator/test and print the real transcript to stdout/stderr:\n'
	printf '  ELIZA_OPENSBI_BOOT_CMD\n'
	printf '  ELIZA_LINUX_BOOT_CMD\n'
	printf '  ELIZA_TRAP_TIMER_IRQ_CMD\n'
	printf '  ELIZA_ISA_CACHE_MMU_CMD\n'
	printf '  ELIZA_AP_BENCHMARKS_CMD\n'
	printf '\n'
	printf 'Optional:\n'
	printf '  ELIZA_GENERATED_MANIFEST=%s\n' "$generated_manifest"
	printf '\n'
	printf 'Run all capture lanes after setting the command env vars:\n'
	printf '  %s all\n' "$0"
	printf '\n'
	printf 'Check command wiring without running the simulator:\n'
	printf '  %s preflight\n' "$0"
	printf '\n'
	printf 'Derive Linux-host command env vars from checked-in generated-AP runners where possible:\n'
	printf "  eval \"\$(python3 scripts/wire_cpu_ap_capture_commands.py --format shell)\"\n"
	printf '  %s wire-preflight\n' "$0"
	printf '\n'
	printf 'Marker checklist:\n'
	printf '  python3 scripts/capture_cpu_ap_evidence.py template all\n'
	printf '  python3 scripts/capture_cpu_ap_evidence.py plan all --format shell\n'
}

env_name_for_mode() {
	case "$1" in
		opensbi-boot) printf 'ELIZA_OPENSBI_BOOT_CMD' ;;
		linux-boot) printf 'ELIZA_LINUX_BOOT_CMD' ;;
		trap-timer-irq) printf 'ELIZA_TRAP_TIMER_IRQ_CMD' ;;
		isa-cache-mmu) printf 'ELIZA_ISA_CACHE_MMU_CMD' ;;
		ap-benchmarks) printf 'ELIZA_AP_BENCHMARKS_CMD' ;;
		*) return 1 ;;
	esac
}

preflight_mode() {
	capture_mode="$1"
	env_name="$(env_name_for_mode "$capture_mode")"
	command_text="$(eval "printf '%s' \"\${$env_name:-}\"")"
	if [ -z "$command_text" ]; then
		printf '  - BLOCKED %s: %s is unset\n' "$capture_mode" "$env_name"
		return 2
	fi
	printf '  - READY %s: %s is set\n' "$capture_mode" "$env_name"
	return 0
}

preflight_all() {
	rc=0
	printf 'STATUS: RUN cpu_ap.capture_preflight\n'
	printf '  generated_manifest: %s\n' "$generated_manifest"
	if [ ! -f "$repo_dir/$generated_manifest" ] && [ ! -f "$generated_manifest" ]; then
		printf '  - BLOCKED generated manifest is missing\n'
		printf '    next: generate/import ElizaRocketConfig before archiving boot evidence\n'
		rc=2
	fi
	for capture_mode in opensbi-boot linux-boot trap-timer-irq isa-cache-mmu ap-benchmarks; do
		if preflight_mode "$capture_mode"; then
			:
		else
			status=$?
			if [ "$status" -gt "$rc" ]; then
				rc="$status"
			fi
		fi
	done
	if [ "$rc" -eq 0 ]; then
		printf 'STATUS: PASS cpu_ap.capture_preflight - all command lanes are wired\n'
	else
		printf 'STATUS: BLOCKED cpu_ap.capture_preflight - capture wiring incomplete\n'
		printf '  next: python3 scripts/wire_cpu_ap_capture_commands.py --format shell\n'
	fi
	return "$rc"
}

wire_commands() {
	python3 "$repo_dir/scripts/wire_cpu_ap_capture_commands.py" --format shell
}

wire_preflight() {
	eval "$(python3 "$repo_dir/scripts/wire_cpu_ap_capture_commands.py" --format shell)"
	preflight_all
}

run_mode() {
	capture_mode="$1"
	env_name="$(env_name_for_mode "$capture_mode")"
	command_text="$(eval "printf '%s' \"\${$env_name:-}\"")"
	if [ -z "$command_text" ]; then
		printf 'STATUS: BLOCKED cpu_ap.capture.%s\n' "$capture_mode"
		printf '  - %s is unset\n' "$env_name"
		printf '  - run: python3 scripts/capture_cpu_ap_evidence.py template %s\n' "$capture_mode"
		return 2
	fi

	mkdir -p "$raw_dir"
	raw_log="$raw_dir/${capture_mode}.raw.log"
	printf 'STATUS: RUN cpu_ap.capture.%s\n' "$capture_mode"
	printf '  command_env: %s\n' "$env_name"
	printf '  raw_log: %s\n' "${raw_log#"$repo_dir"/}"

	set +e
	(
		cd "$repo_dir"
		sh -c "$command_text"
	) >"$raw_log" 2>&1
	status=$?
	set -e
	if [ "$status" -ne 0 ]; then
		printf 'STATUS: FAIL cpu_ap.capture.%s\n' "$capture_mode"
		printf '  - command exited with status %s\n' "$status"
		printf '  - raw transcript kept at %s\n' "${raw_log#"$repo_dir"/}"
		return "$status"
	fi

	python3 "$repo_dir/scripts/capture_cpu_ap_evidence.py" intake "$capture_mode" \
		--source "$raw_log" \
		--command "$command_text" \
		--generated-manifest "$generated_manifest"
}

case "$mode" in
	-h|--help)
		usage
		exit 0
		;;
plan)
	python3 "$repo_dir/scripts/capture_cpu_ap_evidence.py" plan all --format shell
	;;
preflight)
	preflight_all
	;;
wire)
	wire_commands
	;;
wire-preflight)
	wire_preflight
	;;
all)
		rc=0
		for capture_mode in opensbi-boot linux-boot trap-timer-irq isa-cache-mmu ap-benchmarks; do
			if run_mode "$capture_mode"; then
				:
			else
				status=$?
				if [ "$status" -gt "$rc" ]; then
					rc="$status"
				fi
			fi
		done
		exit "$rc"
		;;
	opensbi-boot|linux-boot|trap-timer-irq|isa-cache-mmu|ap-benchmarks)
		run_mode "$mode"
		;;
	*)
		usage >&2
		exit 2
		;;
esac
