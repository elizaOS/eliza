#!/usr/bin/env bash
# check-riscv64-artifacts.sh — QEMU-user-mode smoke for every riscv64
# native artifact this repo cross-compiles.
#
# One-shot harness: walks the known cross-build outputs (native plugins
# + libllama / libggml family + libsigsys-handler-riscv64),
# confirms each is an ELF UCB RISC-V
# 64-bit double-float-ABI object, and exercises every executable smoke
# under qemu-riscv64-static. Shared libraries are validated by ELF tag and
# NEEDED entries because this runner does not assume a guest dynamic-loader
# sysroot.
#
# Default posture: this is *gated* on ELIZA_RISCV64_SMOKE=1 because
# the toolchain dependencies (qemu-user-static, the actual riscv64
# artifacts) are heavy and may not be available on every CI box. With
# the env-var unset the script no-ops and exits 0 with a clean
# "skip" marker, so wiring it into a default-CI step is safe.
#
# Usage:
#   bash scripts/check-riscv64-artifacts.sh                  # honor ELIZA_RISCV64_SMOKE
#   ELIZA_RISCV64_SMOKE=1 bash scripts/check-riscv64-artifacts.sh
#   ELIZA_RISCV64_SMOKE=1 bash scripts/check-riscv64-artifacts.sh --out build/reports/foo.json
#   ELIZA_RISCV64_SMOKE=1 bash scripts/check-riscv64-artifacts.sh --no-qemu  # ELF-tag check only
#   ELIZA_RISCV64_SMOKE=1 bash scripts/check-riscv64-artifacts.sh --require-complete
#       # CI mode: every inventoried artifact must exist; missing output is FAIL
#
# Exit code:
#   0 — every artifact is PASS or a documented SKIP
#   1 — at least one artifact FAILed
#   2 — invalid CLI

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
OUT=""
QEMU_TIMEOUT="${ELIZA_RISCV64_QEMU_TIMEOUT:-60}"
RUN_QEMU=1
REQUIRE_COMPLETE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --out)
            if [ "$#" -lt 2 ] || [ -z "$2" ] || [[ "$2" == --* ]]; then
                echo "--out requires a report path" >&2; exit 2
            fi
            OUT="$2"; shift 2;;
        --no-qemu) RUN_QEMU=0; shift;;
        --require-complete) REQUIRE_COMPLETE=1; shift;;
        --timeout)
            if [ "$#" -lt 2 ] || [[ ! "$2" =~ ^[1-9][0-9]*$ ]]; then
                echo "--timeout requires a positive integer" >&2; exit 2
            fi
            QEMU_TIMEOUT="$2"; shift 2;;
        -h|--help)
            awk 'NR == 1 {next} /^# /{print substr($0,3)} /^#$/{print ""} !/^#/{exit}' "$repo_root/scripts/check-riscv64-artifacts.sh"
            exit 0;;
        *) echo "unknown argument: $1" >&2; exit 2;;
    esac
done

if [[ ! "$QEMU_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
    echo "ELIZA_RISCV64_QEMU_TIMEOUT must be a positive integer" >&2; exit 2
fi

eliza_root="$(node "$repo_root/scripts/eliza-source.ts")"
if [ -z "$eliza_root" ] || [ ! -d "$eliza_root/plugins/plugin-local-inference/native" ]; then
    echo "[check-riscv64-artifacts] set ELIZAOS_ELIZA_ROOT to an elizaOS/eliza checkout." >&2
    exit 2
fi
cd "$repo_root"

if [ -z "$OUT" ]; then
OUT="$(node --input-type=module -e '
    const { testOutputPath } = await import(process.argv[1]);
    console.log(testOutputPath("os-riscv64", process.argv[2]));
' "$eliza_root/packages/scripts/lib/test-output.ts" "artifacts.json")"
fi

mkdir -p "$(dirname "$OUT")"

now_epoch_ms() {
    # GNU date supports %N; macOS doesn't, but riscv64 cross-builds are
    # Linux-only so this script targets Linux-only callers.
    date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))'
}

# JSON record buffer. Each record is a single-line JSON object emitted
# as we go, joined into the final array at the end.
TMP_JSON="$(mktemp -t riscv64-artifacts-XXXXXX.jsonl)"
trap 'rm -f "$TMP_JSON"' EXIT

PASS_N=0; FAIL_N=0; SKIP_N=0

emit_record() {
    # $1 path, $2 kind (executable|shared|static-archive), $3 status, $4 detail, $5 duration_ms
    local path="$1"; local kind="$2"; local status="$3"; local detail="$4"; local dur="$5"
    # Properly JSON-escape detail and path.
    local esc_path esc_detail
    esc_path=$(printf '%s' "$path" | python3 -c 'import sys,json;sys.stdout.write(json.dumps(sys.stdin.read()))')
    esc_detail=$(printf '%s' "$detail" | python3 -c 'import sys,json;sys.stdout.write(json.dumps(sys.stdin.read()))')
    printf '{"path":%s,"kind":"%s","status":"%s","detail":%s,"duration_ms":%s}\n' \
        "$esc_path" "$kind" "$status" "$esc_detail" "$dur" >> "$TMP_JSON"
    case "$status" in
        PASS) PASS_N=$((PASS_N+1));;
        FAIL) FAIL_N=$((FAIL_N+1));;
        SKIP) SKIP_N=$((SKIP_N+1));;
    esac
    printf '  [%-4s] %-70s %s\n' "$status" "${path#"$repo_root"/}" "$detail"
}

write_final_report() {
    local final_status="$1"; local pre_skip_reason="${2:-}"
    python3 - "$OUT" "$TMP_JSON" "$repo_root" "${ELIZA_RISCV64_SMOKE:-}" \
        "${QEMU_BIN:-}" "$RUN_QEMU" "$REQUIRE_COMPLETE" "$QEMU_TIMEOUT" \
        "$PASS_N" "$FAIL_N" "$SKIP_N" "$final_status" "$pre_skip_reason" <<'PYREPORT'
import datetime
import json
import os
import pathlib
import sys
import tempfile

(out, records, root, gate, qemu, run, complete, timeout,
 passed, failed, skipped, status, reason) = sys.argv[1:]
report = {
    "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "repo_root": root,
    "eliza_riscv64_smoke": gate,
    "qemu_bin": qemu,
    "qemu_run": run == "1",
    "require_complete": complete == "1",
    "qemu_timeout_seconds": int(timeout),
    "summary": {"pass": int(passed), "fail": int(failed), "skip": int(skipped)},
    "final_status": status,
    "artifacts": [json.loads(line) for line in pathlib.Path(records).read_text().splitlines()],
}
if reason:
    report["pre_skip_reason"] = reason
partial = None
try:
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=pathlib.Path(out).parent,
                                     prefix=".riscv-report-", delete=False) as stream:
        partial = stream.name
        json.dump(report, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(partial, out)
finally:
    if partial and os.path.exists(partial):
        os.unlink(partial)
PYREPORT
    echo
    echo "Report: $OUT"
    echo "PASS=$PASS_N  SKIP=$SKIP_N  FAIL=$FAIL_N"
}

# ── Gate ─────────────────────────────────────────────────────────────
if [ "$REQUIRE_COMPLETE" = "1" ] && [ "$RUN_QEMU" != "1" ]; then
    emit_record "qemu-riscv64-static" "tool" "FAIL" \
        "--require-complete cannot be combined with --no-qemu" "0"
    write_final_report "FAIL" "strict smoke requires QEMU execution"
    exit 1
fi

if [ "${ELIZA_RISCV64_SMOKE:-0}" != "1" ]; then
    if [ "$REQUIRE_COMPLETE" = "1" ]; then
        emit_record "ELIZA_RISCV64_SMOKE" "configuration" "FAIL" \
            "--require-complete requires ELIZA_RISCV64_SMOKE=1" "0"
        write_final_report "FAIL" "strict smoke gate is disabled"
        exit 1
    fi
    echo "[check-riscv64-artifacts] ELIZA_RISCV64_SMOKE not set; skipping."
    echo "[check-riscv64-artifacts] To run: ELIZA_RISCV64_SMOKE=1 bun run check:riscv64-artifacts"
    write_final_report "SKIP" "ELIZA_RISCV64_SMOKE!=1 (default-CI gate)"
    exit 0
fi

# ── QEMU pre-flight ──────────────────────────────────────────────────
QEMU_BIN="$(command -v qemu-riscv64-static 2>/dev/null || command -v qemu-riscv64 2>/dev/null || true)"
if [ "$RUN_QEMU" = "1" ] && [ -z "$QEMU_BIN" ]; then
    cat >&2 <<'EOF'
[check-riscv64-artifacts] qemu-riscv64-static not found.

Install (Debian/Ubuntu):
    sudo apt-get install -y qemu-user-static binfmt-support

Install (Fedora/RHEL):
    sudo dnf install -y qemu-user-static

Re-run, or pass --no-qemu to ELF-tag-only the artifacts.

Incremental mode treats this run as SKIP. --require-complete fails because the
    requested execution boundary is unavailable.
EOF
    if [ "$REQUIRE_COMPLETE" = "1" ]; then
        emit_record "qemu-riscv64-static" "tool" "FAIL" \
            "required QEMU executable is not installed or not on PATH" "0"
        write_final_report "FAIL" "qemu-riscv64-static missing"
        exit 1
    else
        emit_record "qemu-riscv64-static" "tool" "SKIP" \
            "QEMU executable is not installed or not on PATH" "0"
        write_final_report "SKIP" "qemu-riscv64-static missing"
        exit 0
    fi
fi

echo "[check-riscv64-artifacts] qemu_bin=${QEMU_BIN:-<elf-tag only>}  timeout=${QEMU_TIMEOUT}s"

# ── Verifiers ────────────────────────────────────────────────────────
is_riscv64_elf() {
    bash "$repo_root/scripts/verify-riscv64-elf.sh" "$1"
}

run_executable_under_qemu() {
    # $1 path; remaining arguments are forwarded to the guest executable.
    # Echoes "status|detail|duration_ms".
    local exe="$1"; shift
    if [ ! -x "$exe" ]; then chmod +x "$exe" 2>/dev/null || true; fi
    if [ "$RUN_QEMU" != "1" ] || [ -z "$QEMU_BIN" ]; then
        echo "SKIP|qemu disabled (elf-tag only)|0"
        return
    fi
    local log; log="$(mktemp -t riscv64-smoke-XXXXXX.log)"
    local start end dur ec
    start="$(now_epoch_ms)"
    if timeout "$QEMU_TIMEOUT" "$QEMU_BIN" "$exe" "$@" >"$log" 2>&1; then
        end="$(now_epoch_ms)"; dur=$((end - start))
        rm -f "$log"
        echo "PASS|qemu exit=0|$dur"
    else
        ec=$?
        end="$(now_epoch_ms)"; dur=$((end - start))
        local tail; tail="$(tail -c 240 "$log" 2>/dev/null | tr -d '\r' | tr '\n' ' ' | sed 's/ \+/ /g')"
        rm -f "$log"
        if [ "$ec" = "124" ]; then
            echo "FAIL|qemu timeout after ${QEMU_TIMEOUT}s: $tail|$dur"
        elif [ "$(basename "$exe")" = "qjl_fork_parity" ] &&
             printf '%s' "$tail" | grep -q "Dynamic loading not supported"; then
            # Zig's riscv64-linux-musl executable is static, so musl's dlopen
            # stub cannot load the fork's shared libggml family. This is an
            # unavailable dynamic-loader boundary, not a parity mismatch.
            # Keep the exact reason in the report; a target with a riscv64
            # musl loader/sysroot must run the real fork-parity comparison.
            echo "SKIP|qemu fork parity unavailable (static musl has no dlopen): $tail|$dur"
        elif [ "$ec" = "77" ]; then
            # Conventional autotools / GNU "skip" exit code — the test
            # explicitly punted (usually due to a missing fixture).
            echo "SKIP|qemu exit=77 (test self-skipped, likely missing fixture): $tail|$dur"
        elif [ "$ec" = "2" ] && printf '%s' "$tail" | grep -qE "[Uu]sage:|--help|missing|not provided|fixture" ; then
            # Exit 2 + usage/missing-fixture banner: the test binary
            # requires an external argument (model GGUF, parity input,
            # etc.) that the smoke harness doesn't supply. Treat as
            # SKIP rather than failure — running it correctly is a
            # fixture-provisioning task, not a riscv64 correctness gap.
            echo "SKIP|qemu exit=2, usage/fixture message: $tail|$dur"
        else
            echo "FAIL|qemu exit=$ec: $tail|$dur"
        fi
    fi
}

# Static ELF/dependency inspection only; loading requires a target sysroot.
verify_shared_lib() {
    local so="$1"
    if ! is_riscv64_elf "$so"; then
        echo "FAIL|not a riscv64 ELF (file says: $(file -L -b "$so" 2>/dev/null | head -c 120))|0"
        return
    fi
    local dynamic needed
    if ! dynamic="$(LC_ALL=C readelf -d -- "$so")"; then
        echo "FAIL|cannot inspect shared-library dynamic metadata|0"
        return
    fi
    needed="$(printf '%s\n' "$dynamic" | awk '/NEEDED/ {gsub(/[\[\]]/,"",$NF); print $NF}' | paste -sd, -)"
    if [ -z "$needed" ]; then
        echo "PASS|static RISC-V shared-object headers verified, no NEEDED (leaf .so)|0"
    else
        echo "PASS|static RISC-V shared-object headers verified, NEEDED=[$needed]|0"
    fi
}

verify_static_archive() {
    local a="$1"
    if is_riscv64_elf "$a"; then
        echo "PASS|all members are ELF64 little-endian RISC-V double-float ABI|0"
    else
        echo "FAIL|archive has missing, invalid, or incompatible ELF members|0"
    fi
}

verify_artifact() {
    # $1 = path; remaining arguments are forwarded to executable smokes.
    # Determines kind by extension / executable bit.
    local p="$1"; shift
    if [ ! -e "$p" ]; then
        if [ "$REQUIRE_COMPLETE" = "1" ]; then
            emit_record "$p" "missing" "FAIL" "required artifact was not built" "0"
        else
            emit_record "$p" "missing" "SKIP" "artifact not built yet" "0"
        fi
        return
    fi
    case "$p" in
        *.a)
            local result; result="$(verify_static_archive "$p")"
            local status detail dur
            status="${result%%|*}"; rest="${result#*|}"; detail="${rest%|*}"; dur="${rest##*|}"
            emit_record "$p" "static-archive" "$status" "$detail" "$dur";;
        *.so|*.so.*)
            local result; result="$(verify_shared_lib "$p")"
            local status detail dur
            status="${result%%|*}"; rest="${result#*|}"; detail="${rest%|*}"; dur="${rest##*|}"
            emit_record "$p" "shared-library" "$status" "$detail" "$dur";;
        *)
            if [ -f "$p" ] && is_riscv64_elf "$p"; then
                if [ -x "$p" ] || head -c 4 "$p" | od -An -c 2>/dev/null | grep -q "\\\\177   E   L   F"; then
                    local result; result="$(run_executable_under_qemu "$p" "$@")"
                    local status detail dur
                    status="${result%%|*}"; rest="${result#*|}"; detail="${rest%|*}"; dur="${rest##*|}"
                    emit_record "$p" "executable" "$status" "$detail" "$dur"
                else
                    emit_record "$p" "data" "SKIP" "ELF but not executable" "0"
                fi
            else
                emit_record "$p" "unknown" "FAIL" "not a riscv64 ELF (file: $(file -L -b "$p" 2>/dev/null | head -c 120))" "0"
            fi;;
    esac
}

# ── Artifact inventory ───────────────────────────────────────────────
# Each entry's path is relative to repo root. Missing artifacts are
# reported as SKIP (with reason) — the build-driver script
# scripts/build-riscv64-artifacts.sh is responsible for producing them.

NATIVE_PLUGINS=(
    "qjl-cpu              plugins/plugin-local-inference/native/qjl-cpu/build/riscv64/libqjl.a"
    "qjl-cpu              plugins/plugin-local-inference/native/qjl-cpu/build/riscv64/qjl_int8_smoke"
    "qjl-cpu              plugins/plugin-local-inference/native/qjl-cpu/build/riscv64/qjl_avxvnni_smoke"
    "qjl-cpu              plugins/plugin-local-inference/native/qjl-cpu/build/riscv64/qjl_fork_parity"
    "qjl-cpu              plugins/plugin-local-inference/native/qjl-cpu/build/riscv64/qjl_bench"

    "polarquant-cpu       plugins/plugin-local-inference/native/polarquant-cpu/build/riscv64/libpolarquant.a"
    "polarquant-cpu       plugins/plugin-local-inference/native/polarquant-cpu/build/riscv64/polar_simd_parity_test"
    "polarquant-cpu       plugins/plugin-local-inference/native/polarquant-cpu/build/riscv64/polar_dot_test"
    "polarquant-cpu       plugins/plugin-local-inference/native/polarquant-cpu/build/riscv64/polar_preht_dot_test"
    "polarquant-cpu       plugins/plugin-local-inference/native/polarquant-cpu/build/riscv64/polar_preht_simd_parity_test"
    "polarquant-cpu       plugins/plugin-local-inference/native/polarquant-cpu/build/riscv64/polar_roundtrip_test"
    "polarquant-cpu       plugins/plugin-local-inference/native/polarquant-cpu/build/riscv64/polar_bench"

    "turboquant-cpu       plugins/plugin-local-inference/native/turboquant-cpu/build/riscv64/libturboquant.a"
    "turboquant-cpu       plugins/plugin-local-inference/native/turboquant-cpu/build/riscv64/turboquant_smoke"
    "turboquant-cpu       plugins/plugin-local-inference/native/turboquant-cpu/build/riscv64/turboquant_simd_parity"

    "silero-vad-cpp       plugins/plugin-local-inference/native/silero-vad-cpp/build/riscv64/libsilero_vad.a"
    "silero-vad-cpp       plugins/plugin-local-inference/native/silero-vad-cpp/build/riscv64/libsilero_vad.so"
    "silero-vad-cpp       plugins/plugin-local-inference/native/silero-vad-cpp/build/riscv64/silero_vad_abi_smoke"
    "silero-vad-cpp       plugins/plugin-local-inference/native/silero-vad-cpp/build/riscv64/silero_vad_resample_test"
    "silero-vad-cpp       plugins/plugin-local-inference/native/silero-vad-cpp/build/riscv64/silero_vad_runtime_test"
    "silero-vad-cpp       plugins/plugin-local-inference/native/silero-vad-cpp/build/riscv64/silero_vad_state_test"

    "voice-classifier-cpp plugins/plugin-local-inference/native/voice-classifier-cpp/build/riscv64/libvoice_classifier.a"
    "voice-classifier-cpp plugins/plugin-local-inference/native/voice-classifier-cpp/build/riscv64/libvoice_classifier.so"
    "voice-classifier-cpp plugins/plugin-local-inference/native/voice-classifier-cpp/build/riscv64/voice_classifier_abi_smoke"
    "voice-classifier-cpp plugins/plugin-local-inference/native/voice-classifier-cpp/build/riscv64/voice_diarizer_parity_test"
    "voice-classifier-cpp plugins/plugin-local-inference/native/voice-classifier-cpp/build/riscv64/voice_emotion_classes_test"
    "voice-classifier-cpp plugins/plugin-local-inference/native/voice-classifier-cpp/build/riscv64/voice_gguf_loader_test"
    "voice-classifier-cpp plugins/plugin-local-inference/native/voice-classifier-cpp/build/riscv64/voice_mel_features_test"
    "voice-classifier-cpp plugins/plugin-local-inference/native/voice-classifier-cpp/build/riscv64/voice_speaker_distance_test"
    "voice-classifier-cpp plugins/plugin-local-inference/native/voice-classifier-cpp/build/riscv64/voice_speaker_parity_test"

    "wakeword-cpp         plugins/plugin-local-inference/native/wakeword-cpp/build/riscv64/libwakeword.a"
    "wakeword-cpp         plugins/plugin-local-inference/native/wakeword-cpp/build/riscv64/libwakeword.so"
    "wakeword-cpp         plugins/plugin-local-inference/native/wakeword-cpp/build/riscv64/wakeword_abi_smoke"
    "wakeword-cpp         plugins/plugin-local-inference/native/wakeword-cpp/build/riscv64/wakeword_melspec_test"
    "wakeword-cpp         plugins/plugin-local-inference/native/wakeword-cpp/build/riscv64/wakeword_runtime_test"
    "wakeword-cpp         plugins/plugin-local-inference/native/wakeword-cpp/build/riscv64/wakeword_window_test"

    "face-cpp             plugins/plugin-vision/native/face-cpp/build/riscv64/libface.a"
    "face-cpp             plugins/plugin-vision/native/face-cpp/build/riscv64/libface.so"
    "face-cpp             plugins/plugin-vision/native/face-cpp/build/riscv64/face_abi_smoke"
    "face-cpp             plugins/plugin-vision/native/face-cpp/build/riscv64/face_align_test"
    "face-cpp             plugins/plugin-vision/native/face-cpp/build/riscv64/face_anchor_test"
    "face-cpp             plugins/plugin-vision/native/face-cpp/build/riscv64/face_distance_test"
    "face-cpp             plugins/plugin-vision/native/face-cpp/build/riscv64/face_embed_runtime_test"
    "face-cpp             plugins/plugin-vision/native/face-cpp/build/riscv64/face_runtime_test"

    "doctr-cpp            plugins/plugin-vision/native/doctr-cpp/build/riscv64/libdoctr.a"
    "doctr-cpp            plugins/plugin-vision/native/doctr-cpp/build/riscv64/doctr_abi_smoke"
)

# MTP libllama + ggml family stages into either:
#   build/riscv64-stage/riscv64/                              (linux-riscv64 staging)
#   packages/app/platforms/android/app/src/main/jniLibs/riscv64/
#   packages/app/platforms/android/app/src/main/assets/agent/riscv64/
# We probe all three locations; the harness reports SKIP only if none
# contains the .so.
LLAMA_FAMILY_BASENAMES=(
    libllama.so
    libggml.so
    libggml-base.so
    libggml-cpu.so
    libllama-common.so
    libelizainference.so
)

LLAMA_FAMILY_SEARCH_DIRS=(
    "build/riscv64-stage/riscv64"
    "packages/app/platforms/android/app/src/main/jniLibs/riscv64"
    "packages/app/platforms/android/app/src/main/assets/agent/riscv64"
)

SIGSYS_SEARCH=(
    "${HOME}/.cache/eliza-android-agent/seccomp-shim/riscv64/libsigsys-handler.so"
)

# ── Walk + verify ────────────────────────────────────────────────────
echo "── Native plugins ──"
for entry in "${NATIVE_PLUGINS[@]}"; do
    # shellcheck disable=SC2086
    set -- $entry
    path="$2"
    artifact="$eliza_root/$path"
    if [ "$(basename "$artifact")" = "qjl_fork_parity" ]; then
        # This executable is not a fixture-free smoke: it requires the exact
        # forked libggml-cpu.so produced by the libllama build. Exercise the
        # real cross-artifact parity boundary instead of invoking it with no
        # argument and mistaking its usage exit for a RISC-V failure.
        fork_ggml=""
        for dir in "${LLAMA_FAMILY_SEARCH_DIRS[@]}"; do
            candidate="$eliza_root/$dir/libggml-cpu.so"
            if [ -e "$candidate" ]; then
                fork_ggml="$candidate"
                break
            fi
        done
        if [ -n "$fork_ggml" ]; then
            LD_LIBRARY_PATH="$(dirname "$fork_ggml")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
                verify_artifact "$artifact" "$fork_ggml"
        else
            if [ "$REQUIRE_COMPLETE" = "1" ]; then
                emit_record "$artifact" "executable" "FAIL" \
                    "required fork libggml-cpu.so was not built; parity argument unavailable" "0"
            else
                emit_record "$artifact" "executable" "SKIP" \
                    "fork libggml-cpu.so not built; parity argument unavailable" "0"
            fi
        fi
    else
        verify_artifact "$artifact"
    fi
done

echo
echo "── libllama / libggml family (MTP) ──"
for basename in "${LLAMA_FAMILY_BASENAMES[@]}"; do
    found=""
    for dir in "${LLAMA_FAMILY_SEARCH_DIRS[@]}"; do
        candidate="$eliza_root/$dir/$basename"
        if [ -e "$candidate" ]; then
            found="$candidate"; break
        fi
    done
    if [ -n "$found" ]; then
        verify_artifact "$found"
    else
        # Synthesize a path for the report — caller knows what's missing.
        if [ "$REQUIRE_COMPLETE" = "1" ]; then
            emit_record "$eliza_root/${LLAMA_FAMILY_SEARCH_DIRS[0]}/$basename" "shared-library" "FAIL" \
                "required artifact was not built; run \`bun run build:riscv64-artifacts\`" "0"
        else
            emit_record "$eliza_root/${LLAMA_FAMILY_SEARCH_DIRS[0]}/$basename" "shared-library" "SKIP" \
                "not built; run \`bun run build:riscv64-artifacts\` (libllama for linux-riscv64-cpu + android-riscv64-cpu)" "0"
        fi
    fi
done

echo
echo "── libsigsys-handler-riscv64 (Bun seccomp shim) ──"
s_found=""
for p in "${SIGSYS_SEARCH[@]}"; do
    if [ -e "$p" ]; then s_found="$p"; break; fi
done
if [ -n "$s_found" ]; then
    verify_artifact "$s_found"
else
    if [ "$REQUIRE_COMPLETE" = "1" ]; then
        emit_record "${SIGSYS_SEARCH[0]}" "shared-library" "FAIL" \
            "required artifact was not built; run the elizaOS/eliza compile-shim.ts with --abi riscv64" "0"
    else
        emit_record "${SIGSYS_SEARCH[0]}" "shared-library" "SKIP" \
            "not built; run the elizaOS/eliza compile-shim.ts with --abi riscv64" "0"
    fi
fi

# ── Verdict ──────────────────────────────────────────────────────────
if [ "$FAIL_N" -gt 0 ]; then
    write_final_report "FAIL"
    exit 1
fi
write_final_report "PASS"
exit 0
