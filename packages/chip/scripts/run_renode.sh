#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
if [ "${ELIZA_RENODE_USE_REPO_TOOLS:-1}" = "1" ] && [ -d "$repo_dir/tools/bin" ]; then
    PATH="${PATH}${PATH:+:}$repo_dir/tools/bin"
fi
if [ -d "$repo_dir/.venv/bin" ]; then
    PATH="${PATH}${PATH:+:}$repo_dir/.venv/bin"
fi
firmware="$repo_dir/build/qemu/e1_qemu_firmware.elf"
firmware_lock="$repo_dir/build/qemu/.e1_qemu_firmware.lock"
smoke_log="$repo_dir/build/reports/renode_smoke.log"
smoke_manifest="$repo_dir/build/reports/renode_smoke.manifest"
attempt_log="$repo_dir/build/reports/renode_smoke_attempt.log"
banner_contract="$repo_dir/sim/renode/expected_serial_banner.txt"
banner="eliza e1 qemu"
intake_transcript=
smoke_seconds="${RENODE_SMOKE_SECONDS:-30}"
qemu_transcript="$repo_dir/build/reports/qemu_smoke.log"
qemu_transcript_effective="${RENODE_QEMU_TRANSCRIPT:-$qemu_transcript}"
artifact_dir="$repo_dir/build/renode"
transcript="$artifact_dir/eliza_e1_uart.transcript"
manifest="$artifact_dir/eliza_e1_smoke.json"
status_report="${RENODE_STATUS_REPORT:-$artifact_dir/eliza_e1_status.json}"
schema="$repo_dir/sim/renode/eliza_e1_smoke.schema.json"

status_line() {
    state=$1
    check=$2
    detail=$3
    printf 'STATUS: %s %s - %s\n' "$state" "$check" "$detail"
}

acquire_firmware_lock() {
    timeout=${FIRMWARE_LOCK_TIMEOUT_SECONDS:-120}
    waited=0
    mkdir -p "$repo_dir/build/qemu"
    while ! mkdir "$firmware_lock" 2>/dev/null; do
        if [ "$waited" -ge "$timeout" ]; then
            status_line "FAIL" "renode.firmware_lock" "timed out waiting for ${firmware_lock#"$repo_dir"/}; remove stale lock after confirming no simulator build is running"
            return 1
        fi
        sleep 1
        waited=$((waited + 1))
    done
}

release_firmware_lock() {
    rmdir "$firmware_lock" 2>/dev/null || true
}

emit_status_report() {
    state=$1
    check=$2
    detail=$3
    exit_code=$4
    blocker_kind=${5:-}

    mkdir -p "$(dirname -- "$status_report")"
    renode_path=""
    if command -v renode >/dev/null 2>&1; then
        renode_path=$(command -v renode)
    fi

    python3 - "$status_report" "$state" "$check" "$detail" "$exit_code" "$blocker_kind" "$renode_path" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

report = Path(sys.argv[1])
state = sys.argv[2]
check = sys.argv[3]
detail = sys.argv[4]
exit_code = int(sys.argv[5])
blocker_kind = sys.argv[6] or None
renode_path = sys.argv[7] or None

data = {
    "schema_version": 1,
    "target": "eliza-e1",
    "model_kind": "qemu_virt_reference",
    "status": state,
    "check": check,
    "detail": detail,
    "exit_code": exit_code,
    "blocker_kind": blocker_kind,
    "claim_boundary": "qemu-virt software reference only; not e1-chip hardware ABI boot evidence",
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "silicon_evidence_claim_allowed": False,
    "linux_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
    "false_claim_flags": {
        "claim_allowed": False,
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "hardware_boot_claim_allowed": False,
        "silicon_evidence_claim_allowed": False,
        "linux_boot_claim_allowed": False,
        "production_readiness_claim_allowed": False,
    },
    "command": "scripts/run_renode.sh --check",
    "renode_path": renode_path,
    "generated_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "required_artifacts": {
        "firmware": "build/qemu/e1_qemu_firmware.elf",
        "qemu_reference_transcript": "build/reports/qemu_smoke.log",
        "renode_transcript": "build/renode/eliza_e1_uart.transcript",
        "manifest": "build/renode/eliza_e1_smoke.json",
    },
}
report.write_text(json.dumps(data, indent=2) + "\n")
PY
}

usage() {
    cat <<EOF
usage: scripts/run_renode.sh [--check] [--transcript PATH]

  --check            run semantic checks and report executable smoke status
  --transcript PATH  intake a Renode serial transcript after validating transcript and local preflight evidence

Environment:
  RENODE_SMOKE_SECONDS  bounded run duration in seconds (default: 30)
  --check  run semantic checks and require a bounded executable Renode smoke
EOF
}

expected_banner() {
    if [ -f "$banner_contract" ]; then
        sed -n '1p' "$banner_contract"
    else
        printf '%s\n' "$banner"
    fi
}

mode=run
while [ "$#" -gt 0 ]; do
    case "$1" in
        --check)
            mode=check
            ;;
        --transcript)
            shift
            if [ "$#" -eq 0 ]; then
                usage
                exit 2
            fi
            intake_transcript=$1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            usage
            exit 2
            ;;
    esac
    shift
done

semantic_check() {
    failed=0
    repl="$repo_dir/sim/renode/eliza_e1.repl"
    resc="$repo_dir/sim/renode/eliza_e1.resc"
    readme="$repo_dir/docs/sim/renode/README.md"

    for path in "$repl" "$resc" "$readme" "$banner_contract" "$schema"; do
        if [ ! -f "$path" ]; then
            status_line "FAIL" "renode.semantic" "missing required scaffold ${path#"$repo_dir"/}"
            failed=1
        fi
    done

    if [ "$failed" -ne 0 ]; then
        return 1
    fi

    if [ "$(expected_banner)" != "$banner" ]; then
        status_line "FAIL" "renode.semantic" "sim/renode/expected_serial_banner.txt must contain exactly '$banner'"
        failed=1
    fi

    grep -q "0x80000000" "$repl" || {
        status_line "FAIL" "renode.semantic" "Renode RAM must cover qemu-virt load address 0x80000000"
        failed=1
    }
    grep -q "0x10000000" "$repl" || {
        status_line "FAIL" "renode.semantic" "Renode UART must match qemu-virt UART 0x10000000"
        failed=1
    }
    grep -q "LoadELF @build/qemu/e1_qemu_firmware.elf" "$resc" || {
        status_line "FAIL" "renode.semantic" "sim/renode/eliza_e1.resc must load the qemu-virt firmware ELF"
        failed=1
    }
    grep -q "software reference" "$readme" || {
        status_line "FAIL" "renode.semantic" "docs/sim/renode/README.md must mark Renode as software reference only"
        failed=1
    }
    grep -q "e1-chip hardware ABI" "$readme" || {
        status_line "FAIL" "renode.semantic" "docs/sim/renode/README.md must separate Renode from e1-chip hardware ABI"
        failed=1
    }
    grep -q "$banner" "$readme" || {
        status_line "FAIL" "renode.semantic" "docs/sim/renode/README.md must name the serial banner required for future smoke evidence"
        failed=1
    }
    grep -q "${transcript#"$repo_dir"/}" "$readme" || {
        status_line "FAIL" "renode.semantic" "docs/sim/renode/README.md must name the expected UART transcript artifact"
        failed=1
    }
    grep -q "${manifest#"$repo_dir"/}" "$readme" || {
        status_line "FAIL" "renode.semantic" "docs/sim/renode/README.md must name the expected smoke manifest artifact"
        failed=1
    }
    grep -q "${qemu_transcript#"$repo_dir"/}" "$readme" || {
        status_line "FAIL" "renode.semantic" "docs/sim/renode/README.md must name the QEMU reference transcript artifact"
        failed=1
    }
    grep -q "model_kind" "$schema" || {
        status_line "FAIL" "renode.semantic" "Renode smoke schema must require model_kind"
        failed=1
    }
    grep -q "qemu_virt_reference" "$schema" || {
        status_line "FAIL" "renode.semantic" "Renode smoke schema must identify qemu_virt_reference evidence"
        failed=1
    }
    grep -q "qemu_reference_transcript" "$schema" || {
        status_line "FAIL" "renode.semantic" "Renode smoke schema must require qemu_reference_transcript"
        failed=1
    }

    if [ "$failed" -eq 0 ]; then
        status_line "PASS" "renode.semantic" "platform scaffold, docs, and serial banner contract match qemu-virt"
    fi
    return "$failed"
}

renode_install_hint() {
    cat <<EOF
Renode install/preflight:
  - Install Renode using the official package for this host: https://renode.readthedocs.io/en/latest/introduction/installing.html
  - Confirm the executable is on PATH:
      command -v renode
  - Confirm the CLI starts and reports a version:
      renode --version
  - Build or provide the qemu-virt reference firmware:
      scripts/run_qemu.sh --build-firmware
  - Run the bounded qemu-virt Renode reference check:
      make renode-check
  - If you capture serial manually, archive it as evidence:
      scripts/run_renode.sh --check --transcript path/to/real-renode-serial.log
EOF
}

renode_version() {
    if ! command -v renode >/dev/null 2>&1; then
        return 1
    fi
    renode --version 2>/dev/null | head -n 1 || true
}

renode_version_label() {
    version=$(renode_version || true)
    if [ -n "$version" ]; then
        printf '%s\n' "$version"
    else
        printf 'version-unavailable\n'
    fi
}

renode_missing_detail() {
    # shellcheck disable=SC2016
    printf 'Renode executable missing: command -v renode failed; version unavailable because renode --version could not run; unblock with: install Renode, then run `command -v renode`, `renode --version`, `scripts/run_qemu.sh --build-firmware`, and `make renode-check`.'
}

require_renode_preflight() {
    if ! command -v renode >/dev/null 2>&1; then
        renode_install_hint
        echo "BLOCKED: $(renode_missing_detail)"
        status_line "BLOCKED" "renode.transcript" "cannot intake transcript without a local renode executable and version preflight"
        return 2
    fi

    version=$(renode_version || true)
    if [ -z "$version" ]; then
        status_line "BLOCKED" "renode.transcript" "renode exists at $(command -v renode), but renode --version produced no usable version"
        return 2
    fi

    if [ ! -f "$firmware" ]; then
        status_line "BLOCKED" "renode.transcript" "cannot intake transcript without ${firmware#"$repo_dir"/}; run scripts/run_qemu.sh --build-firmware first"
        return 2
    fi

    return 0
}

sha256_file() {
    path=$1
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$path" | awk '{print $1}'
        return 0
    fi
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$path" | awk '{print $1}'
        return 0
    fi
    printf 'unavailable\n'
}

validate_transcript_file() {
    path=$1

    if [ ! -f "$path" ]; then
        status_line "FAIL" "renode.transcript" "transcript does not exist: $path"
        return 1
    fi
    if [ ! -s "$path" ]; then
        status_line "FAIL" "renode.transcript" "transcript is empty: $path"
        return 1
    fi
    if ! grep -q "$banner" "$path"; then
        status_line "FAIL" "renode.transcript" "transcript did not contain '$banner'"
        return 1
    fi

    return 0
}

manifest_value() {
    key=$1
    file=$2
    awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; found=1; exit } END { if (!found) exit 1 }' "$file"
}

validate_manifest() {
    manifest=$1
    transcript_hash=$2
    firmware_hash=$3

    for key in status check evidence_kind archive sha256 banner banner_contract firmware firmware_sha256 renode renode_version; do
        if ! manifest_value "$key" "$manifest" >/dev/null 2>&1; then
            status_line "FAIL" "renode.manifest" "manifest missing required field: $key"
            return 1
        fi
    done

    if [ "$(manifest_value status "$manifest")" != "PASS" ]; then
        status_line "FAIL" "renode.manifest" "manifest status is not PASS"
        return 1
    fi
    if [ "$(manifest_value check "$manifest")" != "renode.run" ]; then
        status_line "FAIL" "renode.manifest" "manifest check is not renode.run"
        return 1
    fi
    if [ "$(manifest_value evidence_kind "$manifest")" != "renode-executable-transcript" ]; then
        status_line "FAIL" "renode.manifest" "manifest evidence_kind does not mark executable transcript evidence"
        return 1
    fi
    if [ "$(manifest_value sha256 "$manifest")" != "$transcript_hash" ]; then
        status_line "FAIL" "renode.manifest" "manifest transcript hash does not match archived log"
        return 1
    fi
    if [ "$(manifest_value firmware_sha256 "$manifest")" != "$firmware_hash" ]; then
        status_line "FAIL" "renode.manifest" "manifest firmware hash does not match preflight firmware"
        return 1
    fi
    if [ "$(manifest_value banner "$manifest")" != "$banner" ]; then
        status_line "FAIL" "renode.manifest" "manifest banner does not match required serial banner"
        return 1
    fi
    if [ "$(manifest_value banner_contract "$manifest")" != "${banner_contract#"$repo_dir"/}" ]; then
        status_line "FAIL" "renode.manifest" "manifest banner_contract does not match required serial banner contract"
        return 1
    fi

    return 0
}

archive_transcript() {
    path=$1

    validate_transcript_file "$path" || return $?
    require_renode_preflight || return $?

    mkdir -p "$repo_dir/build/reports"
    cp "$path" "$smoke_log"
    transcript_hash=$(sha256_file "$smoke_log")
    firmware_hash=$(sha256_file "$firmware")
    {
        printf 'status=PASS\n'
        printf 'check=renode.run\n'
        printf 'evidence_kind=renode-executable-transcript\n'
        printf 'source=%s\n' "$path"
        printf 'archive=%s\n' "${smoke_log#"$repo_dir"/}"
        printf 'sha256=%s\n' "$transcript_hash"
        printf 'banner=%s\n' "$banner"
        printf 'banner_contract=%s\n' "${banner_contract#"$repo_dir"/}"
        printf 'firmware=%s\n' "${firmware#"$repo_dir"/}"
        printf 'firmware_sha256=%s\n' "$firmware_hash"
        printf 'renode=%s\n' "$(command -v renode)"
        printf 'renode_version=%s\n' "$(renode_version_label)"
    } >"$smoke_manifest"
    validate_manifest "$smoke_manifest" "$transcript_hash" "$firmware_hash" || return 1
    status_line "PASS" "renode.transcript" "archived transcript with required banner to ${smoke_log#"$repo_dir"/}"
    status_line "PASS" "renode.manifest" "validated executable transcript manifest ${smoke_manifest#"$repo_dir"/}"
    status_line "PASS" "renode.run" "transcript contains '$banner'; manifest ${smoke_manifest#"$repo_dir"/}"
    return 0
}

write_run_manifest() {
    source_log=$1
    state=$2
    detail=$3
    transcript_hash=$(sha256_file "$source_log")
    firmware_hash=$(sha256_file "$firmware")

    {
        printf 'status=%s\n' "$state"
        printf 'check=renode.run\n'
        printf 'evidence_kind=renode-executable-transcript\n'
        printf 'source=%s\n' "${source_log#"$repo_dir"/}"
        printf 'archive=%s\n' "${smoke_log#"$repo_dir"/}"
        printf 'sha256=%s\n' "$transcript_hash"
        printf 'banner=%s\n' "$banner"
        printf 'banner_contract=%s\n' "${banner_contract#"$repo_dir"/}"
        printf 'firmware=%s\n' "${firmware#"$repo_dir"/}"
        printf 'firmware_sha256=%s\n' "$firmware_hash"
        printf 'renode=%s\n' "$(command -v renode)"
        printf 'renode_version=%s\n' "$(renode_version_label)"
        printf 'renode_command=renode --console --disable-xwt sim/renode/eliza_e1.resc\n'
        printf 'duration_seconds=%s\n' "$smoke_seconds"
        printf 'detail=%s\n' "$detail"
    } >"$smoke_manifest"
}

run_bounded_smoke() {
    mkdir -p "$repo_dir/build/reports"
    rm -f "$attempt_log"

    renode --console --disable-xwt sim/renode/eliza_e1.resc >"$attempt_log" 2>&1 &
    renode_pid=$!

    sleep "$smoke_seconds"
    if kill -0 "$renode_pid" >/dev/null 2>&1; then
        kill "$renode_pid" >/dev/null 2>&1 || true
    fi
    wait "$renode_pid" >/dev/null 2>&1 || true

    if grep -q "$banner" "$attempt_log"; then
        cp "$attempt_log" "$smoke_log"
        write_run_manifest "$smoke_log" "PASS" "bounded Renode stdout/stderr contained expected serial banner"
        validate_manifest "$smoke_manifest" "$(sha256_file "$smoke_log")" "$(sha256_file "$firmware")" || return 1
        status_line "PASS" "renode.manifest" "validated executable transcript manifest ${smoke_manifest#"$repo_dir"/}"
        status_line "PASS" "renode.run" "bounded smoke saw '$banner'; archived ${smoke_log#"$repo_dir"/}"
        return 0
    fi

    write_run_manifest "$attempt_log" "FAIL" "bounded Renode stdout/stderr did not contain expected serial banner"
    status_line "FAIL" "renode.run" "bounded smoke did not see '$banner'; attempt log ${attempt_log#"$repo_dir"/}"
    return 1
}

blocked() {
    detail=$1
    kind=${2:-missing_prerequisite}
    echo "BLOCKED: $detail"
    status_line "BLOCKED" "renode.run" "$detail"
    if [ "$mode" = "check" ]; then
        status_line "BLOCKED" "renode.check" "$detail"
        if [ "${REQUIRE_RENODE:-0}" != "1" ]; then
            emit_status_report "BLOCKED" "renode.check" "$detail" 0 "$kind"
            exit 0
        fi
    fi
    emit_status_report "BLOCKED" "renode.check" "$detail" 2 "$kind"
    exit 2
}

blocked_check() {
    detail=$1
    kind=${2:-missing_artifact}
    echo "BLOCKED: $detail"
    status_line "BLOCKED" "renode.check" "$detail"
    if [ "${REQUIRE_RENODE:-0}" = "1" ]; then
        emit_status_report "BLOCKED" "renode.check" "$detail" 2 "$kind"
        exit 2
    fi
    emit_status_report "BLOCKED" "renode.check" "$detail" 0 "$kind"
    exit 0
}

run_executable_smoke() {
    if [ ! -s "$qemu_transcript_effective" ]; then
        blocked_check "Renode equivalence needs QEMU reference transcript ${qemu_transcript#"$repo_dir"/}; run scripts/run_qemu.sh --check first." "missing_artifact"
    fi

    renode_path=$(command -v renode)
    python3 - "$repo_dir" "$firmware" "$transcript" "$manifest" "$qemu_transcript_effective" "$banner" "$status_report" "$renode_path" <<'PY'
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

repo = Path(sys.argv[1])
firmware = Path(sys.argv[2])
transcript = Path(sys.argv[3])
manifest = Path(sys.argv[4])
qemu_transcript = Path(sys.argv[5])
banner = sys.argv[6]
status_report = Path(sys.argv[7])
renode_path = sys.argv[8]
timeout_s = float(os.environ.get("RENODE_SMOKE_SECONDS", "30"))

def rel(path: Path) -> str:
    return path.relative_to(repo).as_posix()

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def write_status(status, check, detail, exit_code, blocker_kind):
    data = {
        "schema_version": 1,
        "target": "eliza-e1",
        "model_kind": "qemu_virt_reference",
        "status": status,
        "check": check,
        "detail": detail,
        "exit_code": exit_code,
        "blocker_kind": blocker_kind,
        "claim_boundary": "qemu-virt software reference only; not e1-chip hardware ABI boot evidence",
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "silicon_evidence_claim_allowed": False,
    "linux_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
    "false_claim_flags": {
        "claim_allowed": False,
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "hardware_boot_claim_allowed": False,
        "silicon_evidence_claim_allowed": False,
        "linux_boot_claim_allowed": False,
        "production_readiness_claim_allowed": False,
    },
    "command": "scripts/run_renode.sh --check",
        "renode_path": renode_path,
        "generated_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "required_artifacts": {
            "firmware": "build/qemu/e1_qemu_firmware.elf",
            "qemu_reference_transcript": "build/reports/qemu_smoke.log",
            "renode_transcript": "build/renode/eliza_e1_uart.transcript",
            "manifest": "build/renode/eliza_e1_smoke.json",
        },
    }
    status_report.parent.mkdir(parents=True, exist_ok=True)
    status_report.write_text(json.dumps(data, indent=2) + "\n")

qemu_text = qemu_transcript.read_text(errors="replace")
if banner not in qemu_text:
    detail = f"missing serial banner {banner!r} in {rel(qemu_transcript)}"
    print(f"STATUS: FAIL renode.equivalence - {detail}")
    write_status("FAIL", "renode.equivalence", detail, 1, "artifact_mismatch")
    raise SystemExit(1)

try:
    version_result = subprocess.run(
        [renode_path, "--version"],
        cwd=repo,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=10,
        check=False,
    )
except (OSError, subprocess.TimeoutExpired) as exc:
    detail = f"could not read Renode version from {renode_path}: {exc}"
    print(f"STATUS: BLOCKED renode.version - {detail}")
    write_status("BLOCKED", "renode.version", detail, 2, "tool_execution_blocked")
    raise SystemExit(2)

renode_version = " ".join(line.strip() for line in version_result.stdout.splitlines() if line.strip())
if version_result.returncode != 0 or "Renode" not in renode_version or "fake" in renode_version.lower():
    detail = f"Renode version probe did not identify a real Renode CLI at {renode_path}"
    print(f"STATUS: BLOCKED renode.version - {detail}")
    write_status("BLOCKED", "renode.version", detail, 2, "tool_execution_blocked")
    raise SystemExit(2)

command = [renode_path, "--console", "--disable-xwt", "sim/renode/eliza_e1.resc"]
transcript.parent.mkdir(parents=True, exist_ok=True)
try:
    result = subprocess.run(
        command,
        cwd=repo,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout_s,
        check=False,
    )
    output = result.stdout
    exit_code = result.returncode
    timed_out = False
except subprocess.TimeoutExpired as exc:
    output = (exc.stdout or "") + (exc.stderr or "")
    exit_code = 124
    timed_out = True

transcript.write_text(output)
if banner not in output:
    suffix = " before timeout" if timed_out else ""
    detail = f"bounded Renode run did not emit serial banner {banner!r}{suffix}; archived {rel(transcript)}"
    print(f"STATUS: FAIL renode.run - {detail}")
    write_status("FAIL", "renode.run", detail, 1, "artifact_mismatch")
    raise SystemExit(1)

data = {
    "schema_version": 1,
    "target": "eliza-e1",
    "model_kind": "qemu_virt_reference",
    "command": " ".join(command),
    "firmware": "build/qemu/e1_qemu_firmware.elf",
    "firmware_sha256": sha256(firmware),
    "transcript": "build/renode/eliza_e1_uart.transcript",
    "transcript_sha256": sha256(transcript),
    "qemu_reference_transcript": "build/reports/qemu_smoke.log",
    "qemu_reference_transcript_sha256": sha256(qemu_transcript),
    "expected_banner": banner,
    "observed_banner": banner,
    "renode_version": renode_version,
    "renode_path": renode_path,
    "exit_code": exit_code,
    "timed_out_after_banner": timed_out,
    "generated_by": "scripts/run_renode.sh --check real Renode bounded run",
    "generated_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
}
manifest.write_text(json.dumps(data, indent=2) + "\n")

if exit_code not in (0, 124):
    detail = f"Renode emitted banner but exited with code {exit_code}; archived {rel(transcript)}"
    print(f"STATUS: FAIL renode.run - {detail}")
    write_status("FAIL", "renode.run", detail, 1, "tool_execution_failed")
    raise SystemExit(1)

print(f"STATUS: PASS renode.transcript - found serial banner in {rel(transcript)}")
print(f"STATUS: PASS renode.equivalence - Renode and QEMU transcripts agree on qemu-virt banner and firmware path")
print(f"STATUS: PASS renode.manifest - {rel(manifest)} matches qemu-virt reference schema")
write_status(
    "PASS",
    "renode.check",
    "executable Renode transcript artifacts match qemu-virt reference contract",
    0,
    None,
)
PY
}

cd "$repo_dir"
semantic_check || exit 1

if [ -n "$intake_transcript" ]; then
    archive_transcript "$intake_transcript" || exit $?
    if [ "$mode" = "check" ]; then
        status_line "PASS" "renode.check" "semantic checks and transcript intake passed"
        exit 0
    fi
    exit 0
fi

if ! command -v renode >/dev/null 2>&1; then
    renode_install_hint
    blocked "$(renode_missing_detail) qemu-virt scaffold is present, but no Renode boot transcript was produced." "missing_tool"
fi

if [ "$mode" = "check" ]; then
    acquire_firmware_lock || exit $?
    trap release_firmware_lock EXIT INT TERM
    status_line "PASS" "renode.preflight" "found $(command -v renode) $(renode_version_label)"
    if [ ! -f "$firmware" ]; then
        blocked "Renode executable smoke needs ${firmware#"$repo_dir"/}; run scripts/run_qemu.sh --build-firmware first."
    fi
    status_line "PASS" "renode.preflight" "firmware present ${firmware#"$repo_dir"/}; attempting bounded Renode run for ${smoke_seconds}s"
    set +e
    run_executable_smoke
    status=$?
    set -e
    if [ "$status" -eq 0 ]; then
        status_line "PASS" "renode.check" "semantic, preflight, and executable smoke passed"
        exit 0
    fi
    if [ "$status" -eq 2 ]; then
        status_line "BLOCKED" "renode.check" "executable Renode smoke is blocked by tool preflight"
        if [ "${REQUIRE_RENODE:-0}" != "1" ]; then
            exit 0
        fi
    fi
    exit "$status"
fi

echo "Launching Renode qemu-virt software reference target. This is not the e1-chip hardware ABI."
echo "This interactive target does not create release evidence by itself. For bounded evidence run: make renode-check"
acquire_firmware_lock || exit $?
trap release_firmware_lock EXIT INT TERM
if [ ! -f "$firmware" ]; then
    blocked "Renode run needs ${firmware#"$repo_dir"/}; run scripts/run_qemu.sh --build-firmware first."
fi
renode sim/renode/eliza_e1.resc
