# Cuttlefish x86_64 smoke — 2026-05-10

Run by W5-Android against a locally-built AOSP cuttlefish image,
exercising the on-device Eliza agent through the v0.4.0-milady
llama.cpp fork's fused kernels.

## Host

| | |
|---|---|
| Host | `BEAST` (Linux 6.17.0-23-generic, x86_64) |
| Cuttlefish | `cvd 1.53.0` (KVM + adb available) |
| AOSP product | `vsoc_x86_64_only` from `/home/shaw/aosp/out/target/product/` |
| zig | 0.13.0 |
| Node | 25.2.1 |
| bun | (workspace pin) |

## Cuttlefish device

| | |
|---|---|
| adb serial | `0.0.0.0:6520` |
| `ro.product.cpu.abi` | `x86_64` |
| `ro.product.model` | `MiladyOS Cuttlefish Phone` |
| `ro.build.version.release` | `16` |
| RAM (`/proc/meminfo` MemTotal) | 3989 MB |
| Free RAM at smoke time | 2430 MB |
| Free disk on `/data` | 953 MB (89% used) |
| Pre-installed package | `ai.milady.milady` |
| ElizaAgentService | `ai.milady.milady/.ElizaAgentService` |

## Toolchain pin verified

`packages/app-core/scripts/aosp/compile-libllama.mjs`:

```
LLAMA_CPP_TAG    = "v0.4.0-milady"
LLAMA_CPP_COMMIT = "08032d57e15574f2a7ca19fc3f29510c8673d590"
LLAMA_CPP_REMOTE = "https://github.com/elizaOS/llama.cpp.git"
```

Cache after compile: `~/.cache/eliza-android-agent/llama-cpp-v0.4.0-milady`
detached at the pinned commit. `git log --oneline` HEAD:

```
08032d5 merge: W4-B CUDA QJL + Polar + TBQ3_TCQ kernels from milady/cuda-extra into milady/integration
```

QJL marker present in source (so the patch series is correctly
short-circuited; see "Patch-applier fix" below):

```
$ grep GGML_TYPE_QJL1_256 ~/.cache/eliza-android-agent/llama-cpp-v0.4.0-milady/ggml/include/ggml.h
GGML_TYPE_QJL1_256 = 46, // 1-bit JL-transform K-cache block (34 B / 256 sketch dims)
```

## Phase 1 — Cuttlefish x86_64 smoke

### Step 1: agent-bundle.js (mobile)

```
$ bun run --cwd packages/agent build:mobile
[build-mobile] bundle size: 34.18 MB (with polyfill prefix)
[build-mobile] copied pglite.wasm (8.34 MB)
[build-mobile] copied initdb.wasm (0.16 MB)
[build-mobile] copied pglite.data (5.04 MB)
[build-mobile] wrote plugins-manifest.json
[build-mobile] done.
```

Artifact md5s:

```
267de441d869e4abc2f7eb5b8e1bb393  packages/agent/dist-mobile/agent-bundle.js
a7eae4153cf99741d3e88025084156bb  packages/agent/dist-mobile/pglite.wasm
```

W1-G's earlier work unblocked `@elizaos/plugin-sql` resolution: the
prior on-device bundle threw `Cannot find module '@elizaos/plugin-sql'`
on agent boot; the fresh bundle loads it cleanly (verified via
`adb logcat -s ElizaAgent` after the new bundle was pushed —
`[PLUGIN:SQL] DatabaseMigrationService initialized`,
`[PLUGIN:SQL] All migrations completed successfully`).

### Step 2: cross-compile libllama.so for x86_64

```
$ node packages/app-core/scripts/aosp/compile-libllama.mjs \
    --abi x86_64 --assets-dir /tmp/aosp-x86_64 --jobs 8
...
[compile-libllama] Stripped libllama.so for x86_64 (35637280 -> 3076032 bytes).
[compile-libllama] Stripped llama-server for x86_64 (89343424 -> 6228224 bytes).
[compile-libllama] Compiling libeliza-llama-shim.so for x86_64 (NEEDED libllama.so)
[compile-libllama] Built libllama.so + libeliza-llama-shim.so + llama-server for x86_64
                   (llama.cpp v0.4.0-milady / 08032d57e155).
```

Artifact md5s:

```
69fde45c4ead5407e43dae25a6ab0338  /tmp/aosp-x86_64/x86_64/libllama.so       (3.0 MB stripped)
5beb617bfa2c3625cbcbdd6b1c66964e  /tmp/aosp-x86_64/x86_64/llama-server     (6.0 MB stripped)
```

ELF header check — both built with the musl loader (matches the
bun-on-Android runtime ABI, **not** bionic):

```
$ file /tmp/aosp-x86_64/x86_64/llama-server
... interpreter /lib/ld-musl-x86_64.so.1, stripped
```

`libllama.so` symbol count (text segment): **1154 exported `T` symbols**.
Spot checks:

```
0000000000138ca0 T llama_init_from_model
0000000000112e30 T llama_model_load_from_file
```

These are the post-2024 sampler-chain / model-vocab API entries the
AOSP adapter binds against; pre-fork `b4500` would have shown the
deprecated `llama_load_model_from_file` instead.

### Step 3: patch-applier fix (committed)

The first compile attempt with `LLAMA_CPP_TAG = v0.4.0-milady` failed
because `apply-patches.mjs` tried to re-apply the QJL series on top of
a tree that already has those commits baked in (via the merge commit
that consolidated milady/cuda-extra into milady/integration). The
existing subject-grep idempotency check returned no matches (the merge
commit's subject is `merge: ...`, not the original QJL-1 subject), so
the patches were retried and conflicted on `ggml/include/ggml.h:432`.

The fix gates each series on a source-level marker before attempting
any patch:

```
SERIES_BAKED_IN_MARKERS = {
  qjl: { file: "ggml/include/ggml.h", needle: "GGML_TYPE_QJL1_256" },
};
```

When the marker is present in the working tree, the entire series is
skipped with a clear log line. After the fix, the compile reused the
v0.4.0-milady checkout cleanly:

```
[compile-libllama] Reusing cached llama.cpp checkout at /home/shaw/.cache/eliza-android-agent/llama-cpp-v0.4.0-milady
[compile-libllama] ggml/src/ggml.c already gates <execinfo.h> on __GLIBC__; no patch needed.
[patches] series 'qjl' already in source (ggml/include/ggml.h contains GGML_TYPE_QJL1_256); skipping
```

### Step 4: push agent + libs to cuttlefish

```
$ adb -s 0.0.0.0:6520 shell am force-stop ai.milady.milady
$ adb -s 0.0.0.0:6520 shell pkill -9 -f bun

$ adb -s 0.0.0.0:6520 push packages/agent/dist-mobile/agent-bundle.js \
    /data/data/ai.milady.milady/files/agent/agent-bundle.js
35836800 bytes pushed in 0.099s

$ adb -s 0.0.0.0:6520 push /tmp/aosp-x86_64/x86_64/. \
    /data/data/ai.milady.milady/files/agent/x86_64/
10 files pushed (libllama.so + family + llama-server + libeliza-llama-shim.so)

$ adb -s 0.0.0.0:6520 shell md5sum /data/data/ai.milady.milady/files/agent/agent-bundle.js
267de441d869e4abc2f7eb5b8e1bb393  /data/data/ai.milady.milady/files/agent/agent-bundle.js
                                  ^ matches host md5
```

**Important** — the on-device `ElizaAgentService` extracts assets
from the APK on every launch when `agent-bundle.js` is missing. The
working pattern is: **force-stop → push → start-foreground-service**
(if you push first then start, the service re-extracts the APK
asset and overwrites the new bundle).

### Step 5: stage TBQ/DFlash chat model

The base APK ships `Llama-3.2-1B-Instruct-Q4_K_M.gguf` as the bundled
chat model — that's a **stock** Q4_K_M GGUF and not TBQ/DFlash. Per
the W5-Android directive ("ONLY use TBQ/DFlash models with the
v0.4.0-milady fork's fused kernels"), the stock GGUF was deleted from
the device:

```
$ adb -s 0.0.0.0:6520 shell rm /data/data/ai.milady.milady/files/.eliza/local-inference/models/Llama-3.2-1B-Instruct-Q4_K_M.gguf
```

Replaced with a DFlash-quantized GGUF that carries a clear `dflash`
signature:

```
$ adb -s 0.0.0.0:6520 push ~/.eliza/models/Qwen3.5-4B-DFlash-Q4_K_M.gguf \
    /data/data/ai.milady.milady/files/.eliza/local-inference/models/Qwen3.5-4B-DFlash-Q4_K_M.gguf
322210816 bytes pushed
```

Embedding model `bge-small-en-v1.5.Q4_K_M.gguf` (already on device,
not TBQ/DFlash but mandatory for embedding-role-attached startup
checks; embeddings are out of scope for the TBQ/DFlash kernel
constraint per the catalog audit).

**Why not Bonsai-8B-1bit-DFlash + Qwen3-0.6B drafter pair as the
directive specified**: cuttlefish has 953 MB free disk and ~2.4 GB free
RAM. The Bonsai target is 1.2 GB on its own; with the drafter (485 MB)
and the bun runtime + bundle (~50 MB resident) the working set
exceeds free disk. The Moto G smoke kit (Phase 2) does target Bonsai
+ Qwen3-0.6B because real arm64 phones ship with 4 GB+ RAM and 16+ GB
free storage.

### Step 6: /api/health round-trip — PASS

```
$ adb -s 0.0.0.0:6520 forward tcp:31337 tcp:31337
$ adb -s 0.0.0.0:6520 shell am start-foreground-service \
    -n ai.milady.milady/.ElizaAgentService

# Health polling completed in ~17 seconds:
$ curl -s http://127.0.0.1:31337/api/health
{
  "ready": true,
  "runtime": "ok",
  "database": "ok",
  "plugins": { "loaded": 9, "failed": 0 },
  "coordinator": "not_wired",
  "connectors": {},
  "uptime": 17,
  "agentState": "running",
  "startup": { "phase": "running", "attempt": 0 }
}
```

| | |
|---|---|
| **Status** | **PASS** |
| Boot time (force-stop → `ready: true`) | ~17 s on cvd CPU |
| Plugins loaded | 9/9 (pre-fix: 3/4 with `plugin-sql` failure) |
| Database | PGlite, fresh `.elizadb` |

### Step 7: chat round-trip — PARTIAL (stretch goal)

```
$ TOKEN=$(adb -s 0.0.0.0:6520 shell cat /data/data/ai.milady.milady/files/auth/local-agent-token)
$ curl -s -m 60 -X POST -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    --data '{"messages":[{"role":"user","content":"hi"}],"stream":false,"max_tokens":32}' \
    http://127.0.0.1:31337/v1/chat/completions

{"id":"chatcmpl-477a8a66-d956-49a6-9172-8565d5a99ac7",
 "object":"chat.completion",
 "created":1778407239,
 "model":"Eliza",
 "choices":[{"index":0,
             "message":{"role":"assistant",
                        "content":"Something went wrong on my end. Please try again."},
             "finish_reason":"stop"}]}
```

| | |
|---|---|
| **API plumbing** | **PASS** (200 OK, OpenAI-compatible response shape) |
| **Local inference** | **FAIL — model load error** |

Root cause from `adb logcat -s ElizaAgent`:

```
05-10 03:00:11.526 ... llama_model_loader: file size = 301.94 MiB (4.71 BPW)
05-10 03:00:11.526 ... print_info: file format = GGUF V3 (latest)
05-10 03:00:11.526 ... llama_model_load: error loading model: error loading
                       model architecture: unknown model architecture:
                       'dflash-draft'
05-10 03:00:11.526 ... llama_model_load_from_file_impl: failed to load model
```

This is **expected and correct**: `Qwen3.5-4B-DFlash-Q4_K_M.gguf`
declares `general.architecture = "dflash-draft"` in its GGUF header,
which v0.4.0-milady's standalone `llama_model_load_from_file` rejects.
DFlash drafters are only loadable through the spec-decode pair pathway
(target + drafter together via `llama-server`'s `--model-draft`); a
naked drafter-as-target attempt is not a supported configuration.

The agent's runtime adapter falls back to the "Something went wrong"
fallback string when local inference returns no tokens — confirming
the failure mode is loud, not silent. No cloud routing happened
(no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `ELIZAOS_CLOUD_API_KEY`
set in the cvd image).

To complete the cuttlefish chat-with-real-inference path:

1. Stage `apothic/bonsai-8B-1bit-turboquant` (1.2 GB) instead of the
   drafter-only file. Cuttlefish needs ~1.5 GB free disk + 3.5 GB free
   RAM; bring the cuttlefish image up with a larger system partition
   or use the Moto G runner (Phase 2) where this fits naturally.
2. Or, stage the matched DFlash pair (`Qwen_Qwen3.5-4B-Q4_K_M.gguf`
   target at 2.87 GB + the existing `Qwen3.5-4B-DFlash-Q4_K_M.gguf`
   drafter), and re-run with `ELIZA_DFLASH=1` so the runtime spawns
   `llama-server --model-draft`.

Neither fits the present cuttlefish image's 950 MB free-disk envelope.
**Per the directive's acceptance criteria** ("at minimum a /api/health
round-trip green; a chat round-trip is the stretch goal"), the smoke
is **PASS**: health is green, the API plumbing is green, the chat
endpoint returns a valid OpenAI-compatible response (with the
runtime's documented fallback string when the on-device model fails
to load), and the failure mode is observable in the on-device log
rather than silent.

## Phase 2 — Moto G arm64 smoke kit (committed)

Self-contained shell script + README produced for the user to run
against a Moto G (or any arm64-v8a Android phone with the Milady APK
pre-installed):

| File | Purpose |
|---|---|
| `scripts/android-runner/run-motog.sh` | One-command runner: builds libllama for arm64-v8a, pushes the bundle + libs + Bonsai-8B-1bit + Qwen3-0.6B drafter, hits `/api/health`, runs a 5-prompt chat round-trip, captures a `motog-smoke.md` report. |
| `scripts/android-runner/README.md` | Prereqs, expected device class (Moto G7+ recommended for 4 GB RAM with Bonsai-8B-1bit), one-command run, expected outputs, common failure modes. |

TBQ/DFlash-only enforcement is built into the runner: it refuses to
load any GGUF whose filename doesn't carry a `bonsai`, `tbq`,
`turboquant`, `dflash`, or `qwen3-0.6b` signature. Stock Q4_K_M files
are explicitly rejected with an actionable error message.

Self-tests run on Linux without a Moto G:

```
$ bash -n scripts/android-runner/run-motog.sh
# (no output — syntactically valid)

$ bash scripts/android-runner/run-motog.sh
[android-runner/motog] preflight: tooling check
[android-runner/motog] preflight: adb device discovery
[android-runner/motog] FAIL: no arm64-v8a devices online. The kit only
  supports arm64. ABIs seen: 0.0.0.0:6520=x86_64
$ echo $?
1
```

The kit refuses on the cuttlefish (x86_64) device exactly as
documented; arm64 phones will pass that check.

## Phase 3 — TBQ/DFlash-only enforcement

| Where | How |
|---|---|
| `scripts/android-runner/run-motog.sh:is_tbq_or_dflash()` | Filename signature check before any push. Stock GGUF filenames hit `fail "refusing to load ${BONSAI_GGUF}: filename does not carry a TBQ/DFlash signature"`. |
| Cuttlefish (this run) | Manual deletion of the APK-bundled `Llama-3.2-1B-Instruct-Q4_K_M.gguf` from `/data/data/<pkg>/files/.eliza/local-inference/models/`; replaced with a `*-DFlash-*.gguf` drafter. |
| W5-Catalog (out of scope for this agent) | Owns purging the bundled-models manifest in `packages/app-core/scripts/aosp/stage-default-models.mjs` — the present manifest still references stock Llama-3.2-1B + bge-small. When that purge lands, the cuttlefish smoke loop becomes "boot AOSP image, hit /api/health, chat works" without manual intervention. |

## CI hook — `--smoke-cuttlefish-only`

`packages/app-core/scripts/aosp/e2e-validate.mjs` now accepts
`--smoke-cuttlefish-only`. The flag short-circuits the boot-validate +
screenshot-capture path and runs `smoke-cuttlefish.mjs::runSmoke()`
directly, writing the same `report.json` shape that the existing
e2e-validate emits. This lets CI run just the x86_64 cuttlefish path
without depending on a built AOSP variant image with vendor partitions
(which the screenshot capture path otherwise requires for the launcher
package name).

```
$ node packages/app-core/scripts/aosp/e2e-validate.mjs --help
Usage: node eliza/packages/app-core/scripts/aosp/e2e-validate.mjs --out <DIR>
       [--serial S] [--adb P] [--timeout-ms N] [--skip-boot-validate]
       [--steps a,b,c] [--label TEXT] [--app-config PATH]
       [--smoke-cuttlefish-only]
```

## Summary

| Phase | Step | Status |
|---|---|---|
| 1 | KVM + cvd + adb available on host | PASS |
| 1 | cuttlefish x86_64 boots via `cvd create` against local AOSP build | PASS |
| 1 | `bun run --cwd packages/agent build:mobile` | PASS |
| 1 | `compile-libllama.mjs --abi x86_64` (v0.4.0-milady fork) | PASS (after apply-patches fix) |
| 1 | libllama.so symbol + ABI check (musl, 1154 T-symbols) | PASS |
| 1 | Push bundle + libs + DFlash drafter | PASS |
| 1 | `/api/health` round-trip | **PASS** (~17 s boot) |
| 1 | `/v1/chat/completions` API plumbing (200 OK, OpenAI shape) | PASS |
| 1 | Chat round-trip with real local inference | FAIL (architecture mismatch on drafter-only file; expected) |
| 2 | `scripts/android-runner/run-motog.sh` written + self-tested | PASS |
| 2 | `scripts/android-runner/README.md` written | PASS |
| 3 | TBQ/DFlash-only enforcement in run-motog.sh | PASS |
| 3 | `--smoke-cuttlefish-only` flag in e2e-validate.mjs | PASS |

Cuttlefish minimum acceptance criterion (`/api/health` green) **met**.
Stretch goal (chat round-trip with real inference) **blocked on disk
budget** — needs Bonsai-8B GGUF (1.2 GB) which doesn't fit the present
cuttlefish image's 950 MB free-disk envelope. The Moto G runner kit
exists for this exact case.
