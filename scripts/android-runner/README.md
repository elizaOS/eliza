# android-runner — Moto G arm64 verification kit

Cold-runnable shell script that exercises the on-device Eliza agent on
an arm64-v8a Android phone (Moto G class) using only TBQ/DFlash models
backed by the `milady-ai/llama.cpp` v0.4.0-milady fused kernels.

This is the Android counterpart to `scripts/apple-runner/`: a self-
contained kit produced by an agent without the target hardware, intended
to be run by a developer with a Moto G connected over USB.

## Prerequisites

| Requirement | Why | How to satisfy |
|---|---|---|
| arm64-v8a phone, 4 GB RAM minimum | Bonsai-8B-1bit-DFlash fits in 4 GB only with TBQ KV cache (k=tbq4_0 / v=tbq3_0). | Moto G7+ or newer. The kit refuses non-arm64 ABIs. |
| Android API ≥ 30 | Foreground service + run-as semantics the kit relies on. | Any Moto G shipped 2020+. |
| Milady APK installed | The kit pushes onto an existing app, it does not install one. | `adb install path/to/milady-arm64.apk` once. |
| USB debugging authorised | `adb shell` access. | Settings → Developer options → USB debugging → authorise host RSA fingerprint on the phone. |
| `adb`, `node`, `zig` >= 0.13, `cmake`, `bun`, `git`, `jq`, `curl`, `file` | Cross-compile + push + smoke. | macOS: `brew install android-platform-tools zig cmake bun jq`. Linux: install via your package manager. |
| ~3 GB free disk on the phone | Bundle (~35 MB), libllama family (~17 MB), Bonsai-8B GGUF (~1.2 GB), Qwen3-0.6B drafter (~485 MB), bge-small embedding (~28 MB) plus some headroom. | Free up storage before the run. |
| ~5 GB free disk on the host | llama.cpp checkout cache + per-ABI build tree + cached zig drivers. | `df -h $HOME`. |

## One-command run

```bash
cd /path/to/milady/checkout
./scripts/android-runner/run-motog.sh
```

The script auto-discovers the first connected arm64-v8a device, builds
libllama for arm64-v8a if it isn't already cached at
`.cache/android-runner/arm64-v8a/`, pushes everything, restarts
`ElizaAgentService`, then forwards `tcp:31337` and runs:

1. `GET /api/health` — required to pass.
2. Five sequential `POST /v1/chat/completions` round-trips against
   `bonsai-8b-1bit-dflash` — required to pass for a green run.

After the chat round-trips finish, the script removes the adb forward
and writes a Markdown report to
`reports/porting/<UTC-date>/motog-smoke.md`.

## Required GGUFs

The kit refuses to load anything other than TBQ or DFlash models. Stock
Q4_K_M GGUFs are explicitly rejected — the v0.4.0-milady fused kernels
expect the per-block layouts produced by the apothic TurboQuant /
DFlash quantization pipelines, and silently routing a stock GGUF
through the AOSP adapter would bypass the speculative-decoder path
without a clear failure.

The accepted pair on Moto G:

| Role | HuggingFace repo | File | Size |
|---|---|---|---|
| Target | `apothic/bonsai-8B-1bit-turboquant` | `models/gguf/8B/Bonsai-8B.gguf` | ~1.2 GB |
| DFlash drafter | `bartowski/Qwen_Qwen3-0.6B-GGUF` | `Qwen_Qwen3-0.6B-Q4_K_M.gguf` | ~485 MB |

Drafter pairing is fixed: Qwen3-0.6B shares Bonsai-8B's Qwen3
tokenizer (vocab 151,936) so DFlash speculative decoding accepts
drafted tokens directly without injecting tokenizer.ggml.merges.

The kit auto-discovers the GGUFs in these caches (in order):

1. `$ANDROID_RUNNER_BONSAI_GGUF` / `$ANDROID_RUNNER_DRAFTER_GGUF` (explicit).
2. `~/.cache/eliza/local-inference/models/`
3. `~/.eliza/local-inference/models/`
4. `~/.milady/local-inference/models/`

If neither is found, the script logs the exact `huggingface-cli`
commands you can run to populate them:

```bash
huggingface-cli download apothic/bonsai-8B-1bit-turboquant \
  models/gguf/8B/Bonsai-8B.gguf \
  --local-dir ~/.cache/eliza/local-inference/models/bonsai-8b-1bit-dflash

huggingface-cli download bartowski/Qwen_Qwen3-0.6B-GGUF \
  Qwen_Qwen3-0.6B-Q4_K_M.gguf \
  --local-dir ~/.cache/eliza/local-inference/models/bonsai-8b-dflash-drafter
```

For an even faster iteration loop on a previously-staged device, pass
`--skip-models` and the kit will leave whatever GGUF pair is already on
the phone alone.

## Flags

```bash
./run-motog.sh                     # full run: build + bundle + push + smoke
./run-motog.sh --skip-build        # reuse cached libllama.so
./run-motog.sh --skip-bundle       # reuse staged agent-bundle.js
./run-motog.sh --skip-models       # don't push GGUFs (assume they're on-device)
./run-motog.sh --no-chat           # health endpoint only, no chat round-trip
```

## Env knobs

| Variable | Default | Effect |
|---|---|---|
| `ANDROID_RUNNER_SERIAL` | first arm64-v8a device | Pin to a specific adb serial when multiple devices are attached. |
| `ANDROID_RUNNER_BONSAI_GGUF` | auto-discovered | Override target model GGUF path. |
| `ANDROID_RUNNER_DRAFTER_GGUF` | auto-discovered | Override drafter GGUF path. |
| `ANDROID_RUNNER_PACKAGE` | `ai.milady.milady` | Package id (white-label forks override). |
| `ANDROID_RUNNER_PORT` | `31337` | Host-side port for the adb forward. |
| `ANDROID_RUNNER_REPORT_DIR` | `reports/porting/<UTC-date>` | Override the report output directory. |
| `ANDROID_RUNNER_FORCE_REBUILD` | unset | Force rebuilding `agent-bundle.js` even when the file exists. |

## Expected outputs

```
reports/porting/<UTC-date>/
└── motog-smoke.md
```

The Markdown report contains:

- **Device** block: serial, model, ABI, API level, RAM.
- **Toolchain** block: llama.cpp pin, libllama `file(1)` output, agent
  bundle md5.
- **Health** block: PASS / FAIL plus the `/api/health` response body.
- **Chat round-trip** block: PASS / FAIL plus a numbered table of the
  five prompts, their replies, and per-prompt wall-clock latency.
- **Device-side `agent.log` tail** (last 50 lines).
- **Host-side runner log tail**.

Exit codes:

- `0` — health and chat round-trip both passed.
- `1` — health-check failed (no `/api/health` response in 10 minutes).
- `2` — chat round-trip failed (one or more of the five prompts
  produced an empty / no-response reply).

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `no adb devices online` | Phone not plugged in or USB debugging not authorised. | Plug, enable Developer options → USB debugging, authorise the host RSA fingerprint. |
| `device ABI is 'armeabi-v7a', not arm64-v8a` | Old 32-bit phone. | Out of scope — TBQ/DFlash kernels require 64-bit NEON. |
| `device ABI is 'x86_64'` | Cuttlefish or AVD instead of a real arm64 phone. | For cuttlefish, use `node packages/app-core/scripts/aosp/smoke-cuttlefish.mjs` (or `e2e-validate.mjs --smoke-cuttlefish-only`). |
| `refusing to load <path>: filename does not carry a TBQ/DFlash signature` | A non-TBQ/DFlash GGUF was passed. | Pass a Bonsai-/TBQ-/DFlash-quantized file. The kit will not silently fall back to a stock GGUF. |
| `compile-libllama.mjs ... FAILED: qjl/0001-...` | The cached llama.cpp checkout is from an older fork tag without QJL baked in. | `rm -rf ~/.cache/eliza-android-agent/llama-cpp-*` and re-run; the apply-patches script gates on the `GGML_TYPE_QJL1_256` marker so a fresh `v0.4.0-milady` checkout (which has the type already in source) skips the patch series. |
| `health did not respond within 600s` | The agent service crashed during model load (typically RAM pressure or a missing GGUF in the manifest). | `adb logcat -s ElizaAgent` while the run is in flight; check `reports/porting/<UTC-date>/motog-smoke.md` "Device-side `agent.log` tail". |
| `chat ... FAIL (no response in 1800000ms)` | Bonsai-8B is loading from cold cache; first request can take >5 minutes on a Moto G CPU. | Re-run `--no-chat` first to warm the model, then run the chat round-trip; alternatively raise `--max-time` in the script. |
| `package ai.milady.milady is not installed` | The kit pushes into an existing app's data dir; it does not install the APK. | `adb install path/to/milady-arm64.apk`. |
| `adb root` fails (production build) | Userbuild APK. | The script auto-falls-back to `run-as ${PACKAGE}` for file pushes; this only works on debuggable builds. For non-debuggable userbuilds you need a userdebug image or a debuggable APK. |

## Self-test (run on Linux without a phone)

The agent that produced this kit ran the following on Linux to verify
the refusal paths and shell syntax:

```bash
$ bash -n scripts/android-runner/run-motog.sh
# (no output — script is syntactically valid)

$ ANDROID_RUNNER_PACKAGE=ai.milady.milady bash scripts/android-runner/run-motog.sh
[android-runner/motog] preflight: tooling check
[android-runner/motog] preflight: adb device discovery
[android-runner/motog] FAIL: no adb devices online. Connect the Moto G via USB...

$ ANDROID_RUNNER_BONSAI_GGUF=/tmp/bogus-Q4_K_M.gguf bash scripts/android-runner/run-motog.sh
... (after device discovery passes) ...
[android-runner/motog] FAIL: refusing to load /tmp/bogus-Q4_K_M.gguf:
  filename does not carry a TBQ/DFlash signature ...
```

The TBQ/DFlash refusal triggers strictly off filename — the script
matches `bonsai`, `tbq`, `turboquant`, `dflash`, or `qwen3*0.6b` (the
specific drafter we ship). Add a marker to the filename if you're
running with a custom-quantized GGUF that you've validated against the
v0.4.0-milady fused kernels.

## Where reports land

`reports/porting/<UTC-date>/motog-smoke.md`. Override with
`ANDROID_RUNNER_REPORT_DIR=/abs/path`.

After a real run, commit and push the report:

```bash
git add reports/porting/<UTC-date>/motog-smoke.md
git commit -m "wave-5-G: motog smoke report"
git push
```
