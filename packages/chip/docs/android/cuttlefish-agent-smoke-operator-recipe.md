# Cuttlefish riscv64 Eliza agent smoke recipe

This recipe drives the agent-side gates (D.5--D.13 from the AOSP simulator
completion audit) on top of a live riscv64 Cuttlefish virtual device. It
extends the existing `cuttlefish-smoke` mode of `capture-aosp-evidence.sh`
with a follow-on `cuttlefish-agent-smoke` mode that installs the Eliza APK,
exercises the on-device agent, and archives all assertions to
`docs/evidence/android/eliza_ai_soc_cuttlefish_agent_smoke.log`.

## Claim boundary

This stage produces *virtual-device smoke* evidence only. It is **not**
an Android boot claim, NNAPI claim, or CTS/VTS compatibility claim. The
evidence log keeps the existing
`eliza-evidence: claim_boundary=virtual_device_smoke_only_not_boot_or_compatibility_evidence`
marker that the broader gate already enforces.

## Prerequisites

A 32-core AOSP host with:

- A built `eliza_ai_soc-trunk_staging-userdebug` lunch (host artifacts
  under `out/host/linux-x86`).
- `cvd`/`launch_cvd`, `adb`, `curl`, `file`, and `python3` (>= 3.10) on
  `PATH`.
- A riscv64 Cuttlefish virtual device booted via this repo's standard
  smoke stage (the agent stage assumes the device is already up).
- A built riscv64 Eliza agent APK that registers a foreground service
  binding to TCP `:31337` and exposes
  `/api/agent/{self-status,llama,tts,stt[,sd]}`.
- A small GGUF model under 200 MB (the smoke uses it through the
  on-device llama runner; bigger models work, they just slow the gate).
- A short golden WAV (3--6 seconds, 16-kHz mono PCM is plenty) and its
  reference transcript text.

## End-to-end operator command sequence

Set `AOSP=/path/to/aosp` and `REPO=/path/to/packages/chip` for clarity.

```sh
# 1. Build the AOSP host artifacts and boot Cuttlefish (Task 28 + Task 29).
$REPO/sw/aosp-device/build-aosp-riscv64.sh   # Task 28 owns this
$REPO/sw/aosp-device/launch-cuttlefish-riscv64.sh   # Task 29 owns this
# At this point a CVD is live; record AOSP_ADB_SERIAL from `adb devices`.

# 2. Run the agent-smoke pipeline. install -> start -> end-to-end smoke
#    are exposed as three composable scripts; agent-smoke-riscv64.sh
#    chains all three and archives the evidence transcript.
$REPO/sw/aosp-device/agent-smoke-riscv64.sh \
  --aosp "$AOSP" \
  --serial=<serial-from-adb-devices> \
  --apk=/abs/path/to/eliza-agent-riscv64.apk \
  --llama-model=/abs/path/to/eliza-1.gguf \
  --golden-audio=$REPO/sw/aosp-device/fixtures/golden-stt.wav \
  --golden-transcript="$(cat $REPO/sw/aosp-device/fixtures/golden-stt-transcript.txt)" \
  --wakeword-model=/abs/path/to/wakeword.gguf
# Wakeword stimulus and VAD speech+silence fixtures default to repo-shipped
# files under packages/chip/sw/aosp-device/fixtures/.

# Each phase can also be invoked directly for debugging:
#   $REPO/sw/aosp-device/install-eliza-apk-riscv64.sh --apk=...
#   $REPO/sw/aosp-device/start-eliza-agent-riscv64.sh --serial=...
#   $REPO/sw/aosp-device/capture-aosp-evidence.sh "$AOSP" cuttlefish-agent-smoke

# 3. Validate the resulting evidence.
python3 $REPO/scripts/check_aosp_simulator_completion_gate.py
```

## Environment knobs

The driver lives at
`sw/aosp-device/scripts/cuttlefish_agent_smoke.py` and reads the
following environment variables (all set by the capture wrapper, but you
can override them when invoking it manually).

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOSP_ADB_SERIAL` | empty | adb serial of the live CVD; required if multiple devices are attached. |
| `AOSP_AGENT_APK` | (required) | Host path to the riscv64 Eliza agent APK. |
| `AOSP_AGENT_PACKAGE` | `com.elizaos.agent` | Android package whose pid is polled to confirm the service is alive. |
| `AOSP_AGENT_SERVICE` | `com.elizaos.agent/.AgentService` | Component name passed to `am start-foreground-service`. |
| `AOSP_AGENT_HOST_PORT` | `31337` | Host loopback port for the `adb forward` HTTP probes. |
| `AOSP_AGENT_DEVICE_PORT` | `31337` | Device-side port the agent binds. |
| `AOSP_AGENT_SERVICE_WAIT_SECONDS` | `90` | Max wait for `pidof <package>` to return non-empty. |
| `AOSP_AGENT_PORT_WAIT_SECONDS` | `60` | Max wait for `/api/agent/self-status` to return HTTP 200. |
| `AOSP_AGENT_LLAMA_MODEL` | (required) | Host path to a GGUF model pushed to the device. |
| `AOSP_AGENT_LLAMA_DEVICE_DIR` | `/data/local/tmp/eliza-smoke` | Device staging directory for the model and golden fixture. |
| `AOSP_AGENT_LLAMA_PROMPT` | `Say hello in one short sentence.` | Llama smoke prompt. |
| `AOSP_AGENT_LLAMA_MIN_TOKENS` | `32` | Pass threshold for `LLAMA_TOKENS_GE_32`. |
| `AOSP_AGENT_TTS_TEXT` | `The quick brown fox jumps over the lazy dog.` | Kokoro TTS input. |
| `AOSP_AGENT_GOLDEN_AUDIO` | (required) | Host path to the golden WAV for the Whisper smoke. |
| `AOSP_AGENT_GOLDEN_TRANSCRIPT` | (required) | Reference transcript text for Whisper token-overlap. |
| `AOSP_AGENT_STT_MIN_OVERLAP` | `0.80` | Whisper token-overlap pass threshold. |
| `AOSP_AGENT_SD_OPTIN` | `0` | Set to `1` to run the stable-diffusion sample. |
| `AOSP_AGENT_SD_PROMPT` | `a single red apple on a white background` | Stable-diffusion prompt (used only when opt-in). |
| `AOSP_AGENT_WAKEWORD_MODEL` | `sw/aosp-device/fixtures/wakeword.gguf` | wakeword-cpp GGUF (supply locally; not committed). |
| `AOSP_AGENT_WAKEWORD_AUDIO` | `sw/aosp-device/fixtures/wakeword-stimulus.wav` | wakeword stimulus WAV (repo-shipped fixture). |
| `AOSP_AGENT_VAD_AUDIO` | `sw/aosp-device/fixtures/vad-speech-silence.wav` | speech+silence WAV (repo-shipped fixture). |
| `AOSP_AGENT_REQUIRED_PLUGINS` | `local-inference` | Comma-separated list of plugins whose `status:"ready"` is asserted in `/api/agent/self-status`. |

## Evidence log markers

The evidence log
`docs/evidence/android/eliza_ai_soc_cuttlefish_agent_smoke.log` is
required by `docs/project/aosp-simulator-completion-gate.yaml` under
`required_android_marker_evidence.cuttlefish_agent_smoke`. On a passing
run it contains the standard provenance header
(`EXTERNAL_TREE=`, `COMMAND=`, `START_UTC=`, `END_UTC=`, `RESULT=0`,
`COMPATIBILITY_CLAIM=none`, `BOOT_CLAIM=none`, `SCHEMA=...`,
`eliza-evidence: claim_boundary=virtual_device_smoke_only_...`,
`eliza-evidence: status=PASS`) plus:

| Marker | Meaning |
| --- | --- |
| `AGENT_SERVICE=alive` | `pidof <AOSP_AGENT_PACKAGE>` returned non-empty within `AOSP_AGENT_SERVICE_WAIT_SECONDS`. |
| `AGENT_PID=<pid>` | The first pid returned by `pidof`. |
| `SELF_STATUS_HTTP=200` | `GET /api/agent/self-status` returned HTTP 200. |
| `SELF_STATUS_JSON_SHAPE=ok` | Response body decoded as JSON and contained `agentId`. |
| `SELF_STATUS_REQUIRED_PLUGINS_READY=<csv>` | Each plugin in `AOSP_AGENT_REQUIRED_PLUGINS` returned `status:"ready"`. |
| `LLAMA_HTTP=200`, `LLAMA_TOKENS=<n>`, `LLAMA_WALL_S=<float>` | Llama HTTP status, token count, and wall-clock seconds. |
| `LLAMA_TOKENS_GE_32=true` | `LLAMA_TOKENS >= AOSP_AGENT_LLAMA_MIN_TOKENS`. |
| `TTS_HTTP=200`, `TTS_FILE=...RIFF...WAVE...`, `TTS_SAMPLES=<n>`, `TTS_WAV=ok` | TTS HTTP status, `file(1)` description, decoded sample count, and validation result. |
| `STT_HTTP=200`, `STT_OVERLAP=<float>`, `STT_OVERLAP_GE_0_80=true` | Whisper HTTP status, token-overlap fraction, and pass flag against `AOSP_AGENT_STT_MIN_OVERLAP`. |
| `WAKEWORD_HTTP=200`, `WAKEWORD_DETECTED=true` | wakeword-cpp HTTP status and detection flag on the stimulus fixture. |
| `VAD_HTTP=200`, `VAD_SEGMENTS=<n>` | silero-vad HTTP status and number of speech segments returned on the speech+silence fixture. |
| `SD_SAMPLE=ok` or `SD_SAMPLE=skipped_optin` | Stable-diffusion result (or opt-out marker). |
| `SELF_STATUS_FINAL_HTTP=200`, `SELF_STATUS_FINAL_PLUGINS_READY=<csv>` | Final self-status sweep after every workload has run. |
| `AGENT_LOGCAT=out/eliza-cuttlefish-agent-logcat.txt` | Path under the AOSP tree to the captured `logcat -d -b all`. |
| `AGENT_DMESG=out/eliza-cuttlefish-agent-dmesg.txt` | Path to the device `dmesg` snapshot. |
| `AGENT_GETPROP=out/eliza-cuttlefish-agent-getprop.txt` | Path to the device `getprop` snapshot. |

## Failure paths

The wrapper exits non-zero on the first failing gate and the evidence
log ends with `eliza-evidence: status=FAIL` plus `RESULT=<rc>`. The
gate checker (`check_aosp_simulator_completion_gate.py`) then reports
the missing markers under `BLOCKED`. Re-run the stage after fixing the
underlying issue; there is no "best-effort" or partial-pass mode by
design.
