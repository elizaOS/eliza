# android-runner — Moto G arm64 verification kit

Cold-runnable shell script that exercises the on-device Eliza agent on an
arm64-v8a Android phone using the Eliza-1 local GGUF path backed by the
`elizaOS/llama.cpp` fused kernels.

## Prerequisites

| Requirement | Why | How to satisfy |
|---|---|---|
| arm64-v8a phone, 4 GB RAM minimum | Eliza-1 mobile needs a 4 GB class device for a useful smoke run. | Moto G7+ or newer. |
| Android API >= 30 | Foreground service + run-as semantics the kit relies on. | Any Moto G shipped 2020+. |
| Milady APK installed | The kit pushes onto an existing app; it does not install one. | `adb install path/to/milady-arm64.apk` once. |
| USB debugging authorised | `adb shell` access. | Enable USB debugging and authorise the host. |
| `adb`, `node`, `zig` >= 0.13, `cmake`, `bun`, `git`, `jq`, `curl`, `file` | Cross-compile + push + smoke. | macOS: `brew install android-platform-tools zig cmake bun jq`. |
| ~3 GB free disk on the phone | Bundle, libllama family, and Eliza-1 mobile GGUF. | Free up storage before the run. |

## One-command run

```bash
cd /path/to/milady/checkout
./scripts/android-runner/run-motog.sh
```

The script auto-discovers the first connected arm64-v8a device, builds
`libllama` for arm64-v8a if needed, pushes the agent bundle and Eliza-1
model, restarts `ElizaAgentService`, forwards `tcp:31337`, and runs:

1. `GET /api/health`
2. Five sequential `POST /v1/chat/completions` requests against
   `eliza-1-mobile-1_7b`

Reports are written to `reports/porting/<UTC-date>/motog-smoke.md`.

## Required GGUF

The runner uses the Eliza-1 mobile GGUF:

| Role | Hugging Face repo | File |
|---|---|---|
| Chat | `elizaos/eliza-1-mobile-1_7b` | `text/eliza-1-mobile-1_7b-32k.gguf` |

The kit auto-discovers the GGUF in:

1. `$ANDROID_RUNNER_ELIZA1_GGUF`
2. `~/.cache/eliza/local-inference/models/`
3. `~/.eliza/local-inference/models/`
4. `~/.milady/local-inference/models/`

If it is not found, download it with:

```bash
hf download elizaos/eliza-1-mobile-1_7b \
  text/eliza-1-mobile-1_7b-32k.gguf \
  --local-dir ~/.cache/eliza/local-inference/models/eliza-1-mobile-1_7b
```

For a previously-staged device, pass `--skip-models`.

## Flags

```bash
./run-motog.sh                     # full run: build + bundle + push + smoke
./run-motog.sh --skip-build        # reuse cached libllama.so
./run-motog.sh --skip-bundle       # reuse staged agent-bundle.js
./run-motog.sh --skip-models       # don't push GGUFs
./run-motog.sh --no-chat           # health endpoint only
```

## Env knobs

| Variable | Default | Effect |
|---|---|---|
| `ANDROID_RUNNER_SERIAL` | first arm64-v8a device | Pin to a specific adb serial. |
| `ANDROID_RUNNER_ELIZA1_GGUF` | auto-discovered | Override Eliza-1 mobile GGUF path. |
| `ANDROID_RUNNER_PACKAGE` | `ai.milady.milady` | Package id. |
| `ANDROID_RUNNER_PORT` | `31337` | Host-side port for adb forward. |
| `ANDROID_RUNNER_REPORT_DIR` | `reports/porting/<UTC-date>` | Override report output directory. |
| `ANDROID_RUNNER_FORCE_REBUILD` | unset | Force rebuilding `agent-bundle.js`. |

## Exit Codes

- `0` — health and chat round-trip both passed.
- `1` — health-check failed.
- `2` — chat round-trip failed.
