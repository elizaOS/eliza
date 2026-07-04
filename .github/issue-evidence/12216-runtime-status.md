# Issue #12216 — Part B: download / cloud-proxy / on-device runtime hardening

Branch: `fix/12216-inference-runtime-hardening` (10 commits on top of the
worktree base `80f9c055ed0` → `03dbd8c501e` develop tip).

This is the headless (TS/doc/test), CI-runnable slice of the #12216 plan's
Stages 5–6 + Section B cloud-proxy answer. GPU/device/HF-gated items are tracked
in the remainder section below, not attempted.

---

## Fixes landed

| Fix | Summary | Files |
|-----|---------|-------|
| **C5 (P0)** | Scope the cloud hf-proxy route to the curated `elizaos/` org; 403 for any other repo — closes the "any authed cloud user proxy-downloads ANY HF repo with the cloud's HF_TOKEN" vector. `ALLOWED_REPO_PREFIX` pinned to the org segment of `ELIZA_1_HF_REPO` via an agreement test (so a shared-repo rename can't silently un-scope it). | `packages/cloud/api/v1/hf-proxy/[...path]/route.ts`, `packages/cloud/api/__tests__/hf-proxy-route.test.ts` |
| **C6 (P1)** | Log proxied repo/path/status/bytes with redacted orgId/userId after the upstream fetch — cost observability on a previously-unmetered multi-GB transfer. | same route + test |
| **C8 (P1)** | 429/5xx transient-retry with bounded backoff in the downloader's single `loadHttpClient().request` chokepoint (both fetch sites), ported from `lifecycle-remote-checks.ts`. 429 no longer treated as a hard 404. | `plugins/plugin-local-inference/src/services/downloader.ts`, `downloader.test.ts` |
| **C9 (P1)** | 401/403 → typed `GatedRepoError` (`code: "HF_GATED_REPO"`, carries `httpStatus`) at both `>= 400` sites, **propagated to the consumer**: `errorCode`/`errorHttpStatus` added to `DownloadJob` + `LocalInferenceDownloadStatus`, set in the failure catch, and carried through `statusFromJobs` into the status DTO. Consumer-boundary tests (failed-event, persistence round-trip, `buildTextGenerationReadiness` DTO). | downloader.ts + test, `readiness.ts` + test, `packages/shared/src/local-inference/types.ts` |
| **C12 (P2)** | `logResolvedKernelSet()` `console.info` → structured `logger.info` (keeps `[LocalInferenceEngine]` prefix). | `plugins/plugin-local-inference/src/services/active-model.ts` |
| **C13 (P2)** | Two `required-kernels-gate.test.ts` cases pinning the AGENTS.md §3 Gemma exception: a Gemma manifest with only `turboquant_q4` (no QJL/Polar/TCQ) does NOT throw; missing `turboquant_q4` still hard-fails. | `required-kernels-gate.test.ts` |
| **C11 (P2, detection only)** | Static-analysis test pinning the memory-arbiter voice/ASR/TTS bypass: only `vision-describe`/`image-gen` register through the arbiter; `voice/` loads GGUFs via direct `bun:ffi`/`dlopen`. Detects drift in either direction. Full re-wire is a flagged follow-up. | `plugins/plugin-local-inference/src/services/arbiter-bypass-detection.test.ts` |
| **C15 (P2)** | Reconcile native/AGENTS.md §11 ONNX table (Wav2Small/WeSpeaker/pyannote-3 → ONNX-free; zero onnxruntime imports exist) + mirror to CLAUDE.md. Grep test banning `onnxruntime-*` imports. The dead acoustic-emotion path is documented honestly as a tracked K1 follow-up (see below) — an earlier fail-loud `classifyVoiceEmotion()` stub was **removed** after review found it unreachable (zero call sites → not enforced behavior). | `voice-emotion-classifier.ts` (+ test), `emotion-attribution.ts`, `manifest/schema.ts`, `native/AGENTS.md`, `native/CLAUDE.md`, `onnx-import-ban.test.ts` |
| **C16 (P2)** | Delete dead `packages/app-core/scripts/omnivoice-fuse/prepare.mjs` (zero live importers; active path is `build-helpers/omnivoice-merged.mjs`) + regression test blocking regrowth. | `packages/app-core/scripts/omnivoice-fuse-removed.test.ts` (+ deletion) |
| **C18 (P3)** | Honest `android-arm64-litertlm` `authored-pending-hardware` row in PLATFORM_MATRIX.md — LiteRT-LM is live dispatcher code with zero prior matrix rows. | `plugins/plugin-local-inference/native/verify/PLATFORM_MATRIX.md` |

---

## Cloud-proxy recommendation (plan Section B — now implemented)

**Keep direct-public HF fetch as the default.** The shipping eliza-1 catalog is
public; routing everything through the cloud by default adds egress cost + a
single point of failure for zero benefit on the common case. The cloud-proxy
path (`resolveHfDownloadBase()` in `packages/shared/src/local-inference/hf-proxy.ts`)
correctly stays opt-in, gated on cloud-key presence, for the gated-repo fallback.

The two production-safety gaps that made the proxy unsafe to rely on are now
closed in-repo:
- **Unscoped abuse vector → C5.** The route now refuses any repo outside the
  `elizaos/` org with a 403 (was: only checked for a `/resolve/` segment).
- **Zero cost observability → C6.** Every proxied transfer now logs
  repo/path/status/bytes + redacted identity.

No default flip. No new proxy dependency for the common (public) case.

---

## Flagged follow-ups (NOT silently fixed)

### Voice-emotion acoustic read — dead path, native binding owed (C15)
The ONNX Wav2Small runtime was deleted before the native GGUF read was wired.
Confirmed the acoustic path is fully DEAD at runtime: **no** code loads a
`files.emotion` GGUF, and **no** production caller of `attributeVoiceEmotion()`
supplies a `model` (acoustic read), so the fusion runs text/prosody-only.
(An earlier attempt added a fail-loud `classifyVoiceEmotion()` stub; adversarial
review correctly flagged it as unreachable — zero call sites means it enforced
nothing — so it was removed rather than left pretending to be enforced behavior.
The honest doc reconciliation + the onnx-import-ban test remain.)
**Follow-up (out of headless scope — a real feature):** bind the
`voice_emotion.c` GGUF forward into `libelizainference` through the memory
arbiter (K1) + add a runtime activation gate that rejects a shipped-but-
unrunnable `files.emotion` artifact + a parity gate. Until then, no production
bundle ships a `files.emotion` artifact.

### Memory-arbiter voice/ASR/TTS bypass — detected, re-wire owed (C11)
Only `vision-describe`/`image-gen` register through the arbiter. `text`,
`embedding`, `transcribe` have full API surface that throws "no capability
registered" (dead API), and voice/ASR/TTS load GGUF weights via direct FFI with
no arbiter involvement — a real, partial violation of the plugin's own "never
load models independently" rule. C11 adds a detector; the **re-wire** (register
`transcribe`/`text-to-speech` capabilities, route voice FFI loads through
`arbiter.registerCapability`) is a feature change, not attempted here.

---

## Device / HF-gated remainder (plan Section D — out of headless scope)

- **LiteRT-LM hardware verify:** dispatcher/loader/manifest-runtime exist, zero
  NPU-device run, no `verify/`-side `.litertlm` parity harness. Needs a physical
  Android NPU device + a converted `.litertlm` bundle. (C18 records this
  honestly.)
- **MTP drafter hosting for 9b / 27b / 27b-256k:** only `2b`/`4b` have hosted
  drafter GGUFs today; the larger-tier drafters are declared in the contract but
  unpublished (Gemma-4-E4B drafter conversion still in progress). Device/HF-gated.
- **Live hf-proxy end-to-end:** no test composes the real client + cloud route +
  downloader against actual HuggingFace infra (HF-gated). C5/C6 tests exercise
  the route headlessly with a faked upstream.

---

## Verification (real output)

Worktrees share the parent `node_modules`. One fresh-worktree prep step was
needed: `node ../shared/scripts/generate-keywords.mjs --target ts` in
`packages/core` to generate `src/i18n/generated/validation-keyword-data.ts`
(otherwise `@elizaos/core` import fails); generated file is untracked, not
committed.

### plugin-local-inference — touched test files (post-review)
```
$ bunx vitest run \
    src/services/downloader.test.ts \
    src/services/readiness.test.ts \
    src/services/required-kernels-gate.test.ts \
    src/services/voice/voice-emotion-classifier.test.ts \
    src/services/voice/onnx-import-ban.test.ts \
    src/services/voice/emotion-attribution.test.ts \
    src/services/arbiter-bypass-detection.test.ts

 Test Files  7 passed (7)
      Tests  56 passed (56)
```

### cloud — hf-proxy route (post-review: + 403-consumer-code + allowlist-agreement)
```
$ bun test api/__tests__/hf-proxy-route.test.ts
 6 pass
 0 fail
 22 expect() calls
```

### app-core — omnivoice-fuse-removed
```
$ bunx vitest run scripts/omnivoice-fuse-removed.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

### Typecheck
```
$ (plugins/plugin-local-inference) bunx tsgo --noEmit
plugin typecheck exit: 0   (0 errors)
```
`packages/cloud/api` `tsgo --noEmit` and `packages/shared` `tsgo --noEmit` exit
non-zero, but EVERY error is in a file this branch did NOT touch or is a
worktree-resolution artifact of the shared parent `node_modules`:
- cloud/api: `fal/proxy/route.ts` (`hono@4.12.18` vs `4.12.27` duplicate-package
  skew), `../shared/src/lib/services/market-preview.ts`,
  `__tests__/stripe-connect-webhook-route.test.ts` — **zero** hf-proxy errors.
- shared: 2 × `TS2688 Cannot find type definition file for 'bun-types'/'node'`
  (typeRoots resolution, not my `types.ts` change; the plugin — which imports
  the new `DownloadJob.errorCode`/`errorHttpStatus` fields — typechecks clean at
  exit 0, transitively validating the shape).

This is the known shared-parent-node_modules worktree gotcha — relies on CI's
clean install for the cloud/shared lanes.

### Lint
```
$ bunx @biomejs/biome check <11 touched files>
Checked 11 files in 83ms. No fixes applied.   (0 errors, 0 warnings)
```

---

## Adversarial-review fixes (post-first-report)

Three confirmed issues from the coordinator's review, all addressed:

1. **C9 didn't reach a consumer** — the typed `GatedRepoError` code was
   stringified into `DownloadJob.error`. Fixed: `errorCode`/`errorHttpStatus`
   now on `DownloadJob` + `LocalInferenceDownloadStatus`, set in the failure
   catch, carried through `statusFromJobs`. Tests assert at the consumer
   boundary (failed event, persistence round-trip, readiness DTO).
2. **Unreachable fail-loud stub** — `classifyVoiceEmotion()` had zero call
   sites. Confirmed the acoustic path is fully dead (no `files.emotion` loader,
   no caller passes `model`). Removed the stub; kept the honest doc
   reconciliation + onnx-import-ban; flagged the native binding as a K1
   follow-up.
3. **Hardcoded allowlist literal** — `ALLOWED_REPO_PREFIX` now pinned to the org
   segment of `ELIZA_1_HF_REPO` (from `@elizaos/shared`) via an agreement test.

## Commits
```
3d6cbe376a6 fix(#12216): biome format on downloader.test.ts (C9 round-trip assertion)
92d3b0de7f8 fix(#12216): C5 pin hf-proxy allowlist to ELIZA_1_HF_REPO via agreement test
332ef59f526 fix(#12216): C15 drop unreachable classifyVoiceEmotion stub; flag dead path
575f1ea3dae fix(#12216): C9 propagate GatedRepoError code to the consumer boundary
0208f7fa888 fix(#12216): biome format + lint cleanup on touched files
fc1d2aa0033 fix(#12216): C18 add honest LiteRT-LM row to PLATFORM_MATRIX
787b4d3cd25 fix(#12216): C11 detect memory-arbiter voice/ASR/TTS bypass (detection only)
8d6656ae16b fix(#12216): C15 reconcile ONNX doc + fail-loud voice-emotion classifier
9681c425520 fix(#12216): C16 delete dead omnivoice-fuse legacy graft + regression test
af25d78cb6e fix(#12216): C13 test Gemma QJL/Polar-absence exception at manifest gate
9530b709afc fix(#12216): C12 use structured logger in logResolvedKernelSet
cd01325db26 fix(#12216): C8+C9 downloader 429 backoff retry + typed GatedRepoError
0bd129a7b20 fix(#12216): C5+C6 scope cloud hf-proxy to curated catalog + log proxied bytes
```
(The base commit `80f9c055ed0 fix(core): let providers opt out of default
registration (#12270)` was already the worktree HEAD before this work began — it
is NOT part of this task.)
