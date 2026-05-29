#!/usr/bin/env sh
# Capture and validate the positive secure-boot ROM handoff transcript.
#
# This wrapper does not synthesize success. It archives stdout/stderr from the
# command named by ELIZA_BOOTROM_POSITIVE_HANDOFF_CMD, then delegates marker
# validation to scripts/check_bootrom_positive_handoff.py.
set -eu

repo_dir="$(CDPATH=; cd -- "$(dirname "$0")/.." && pwd)"
transcript="${ELIZA_BOOTROM_POSITIVE_HANDOFF_TRANSCRIPT:-$repo_dir/docs/boot-rom/transcripts/e1_secure_bootrom_positive_handoff_qemu_rv64.txt}"
report="${ELIZA_BOOTROM_POSITIVE_HANDOFF_REPORT:-$repo_dir/build/reports/gate-bootrom-positive-handoff-check.json}"
cmd="${ELIZA_BOOTROM_POSITIVE_HANDOFF_CMD:-}"
mode="${1:-run}"

usage() {
	printf 'usage: %s [plan|preflight|run]\n' "$0"
	printf '\n'
	printf 'Set ELIZA_BOOTROM_POSITIVE_HANDOFF_CMD to the command that runs the real provisioned-root signed-image boot ROM simulation and prints its transcript.\n'
	printf 'The transcript must contain reset-vector, verifier-entrypoint, authenticated-image, manifest-target, and OpenSBI-entry markers.\n'
}

plan() {
	cat <<EOF
# Positive secure-boot ROM handoff capture.
export ELIZA_BOOTROM_POSITIVE_HANDOFF_CMD=''
export ELIZA_BOOTROM_POSITIVE_HANDOFF_TRANSCRIPT='${transcript}'
export ELIZA_BOOTROM_POSITIVE_HANDOFF_REPORT='${report}'

# Required transcript markers:
# - reset-vector-fetch <_start>
# - <e1_secure_boot_main>
# - authenticated-image-verified
# - handoff-target-loaded-from-manifest
# - OpenSBI entry

scripts/capture_bootrom_positive_handoff.sh run
python3 scripts/check_bootrom_positive_handoff.py
python3 scripts/check_boot_security_chain_contract.py
EOF
}

preflight() {
	if [ -z "$cmd" ]; then
		printf 'STATUS: BLOCKED bootrom.positive_handoff_capture_preflight\n'
		printf '  - ELIZA_BOOTROM_POSITIVE_HANDOFF_CMD is unset; no real signed-image simulator transcript can be captured\n'
		printf '  - next: scripts/capture_bootrom_positive_handoff.sh plan\n'
		ELIZA_BOOTROM_POSITIVE_HANDOFF_TRANSCRIPT="$transcript" \
		ELIZA_BOOTROM_POSITIVE_HANDOFF_REPORT="$report" \
			python3 "$repo_dir/scripts/check_bootrom_positive_handoff.py" >/dev/null || true
		printf '  - report: %s\n' "${report#"$repo_dir"/}"
		return 2
	fi
	printf 'STATUS: PASS bootrom.positive_handoff_capture_preflight\n'
	return 0
}

capture() {
	if ! preflight; then
		return 2
	fi
	mkdir -p "$(dirname "$transcript")"
	{
		printf '## bootrom_positive_handoff transcript\n'
		printf '## command: %s\n' "$cmd"
		printf '## claim_boundary: provisioned_test_root_signed_image_simulator_only_not_silicon_attestation\n'
		printf '##\n'
	} >"$transcript"
	set +e
	(
		cd "$repo_dir"
		sh -c "$cmd"
	) >>"$transcript" 2>&1
	status=$?
	set -e
	printf '## command_exit_code: %s\n' "$status" >>"$transcript"
	if [ "$status" -ne 0 ]; then
		printf 'STATUS: BLOCKED bootrom.positive_handoff_capture\n'
		printf '  - command exited with status %s\n' "$status"
		printf '  - transcript: %s\n' "${transcript#"$repo_dir"/}"
		return "$status"
	fi
	ELIZA_BOOTROM_POSITIVE_HANDOFF_TRANSCRIPT="$transcript" \
	ELIZA_BOOTROM_POSITIVE_HANDOFF_REPORT="$report" \
		python3 "$repo_dir/scripts/check_bootrom_positive_handoff.py"
}

case "$mode" in
	-h|--help)
		usage
		;;
	plan)
		plan
		;;
	preflight)
		preflight
		;;
	run)
		capture
		;;
	*)
		usage >&2
		exit 2
		;;
esac
