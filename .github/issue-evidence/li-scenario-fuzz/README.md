# local-inference scenario + fuzz evidence (2026-07-02)

Evidence bundle for the local-inference REAL scenario + fuzz coverage pass.

## Fuzz coverage (no live model — real functions, no mocks)

Suite: `bun run --cwd plugins/plugin-local-inference test` → **225 files passed | 1 skipped, 2299 tests passed | 13 skipped** (77s).

- `plugins/plugin-local-inference/src/services/load-args-drafter.fuzz.test.ts` (NEW, this pass — 22 tests):
  - `resolveLocalInferenceLoadArgs`: missing separate-drafter GGUF under bundleRoot **throws** (never a silent non-speculative load); manifest `files.mtp` beats catalog `drafterFile`; missing-manifest-entry falls through to the on-disk catalog drafter; invalid merged overrides rejected (contextSize<256, unknown KV type, bogus kvOffload, negative gpuLayers); fork KV types accepted at resolve (`allowFork`) and normalized; mobile context ceiling clamp incl. garbage `ELIZA_MOBILE_CONTEXT_CEILING` fuzz.
  - `validateLocalInferenceLoadArgs`: 3000-shape differential fuzz vs an oracle, both `allowFork` modes.
  - `readGgufArchitecture` (GGUF header metadata boundary; the TS counterpart of the native `embedding_length_out` mismatch gate in `gemma4-assistant.cpp`): crafted valid header parses; **every** truncation fails closed (null); non-string arch, `0xFFFF…` u64 lengths, absurd kv_count, 500 random-byte/bit-flip mutations — never throws; non-Gemma arch → release blocker via `collectTextArchitectureBlockers`.
- Already landed in prior commits (verified green in the same suite run):
  - `src/routes/local-inference-route-contracts.fuzz.test.ts` — TTS/ASR route input contracts (2000/1500-shape body fuzz, status-code envelope {200,400,413,502,503}).
  - `src/services/downloader-manifest.fuzz.test.ts` — manifest parser (malformed/empty/oversized/truncated JSON, object-vs-array `files.vision`, conflicting-sha mtp entry, install-root confinement).

## Scenario trajectories (scenario-runner, real AgentRuntime + PGLite)

Command shape: `bun packages/scenario-runner/bin/eliza-scenarios run <dir> --scenario <id> --report <out>`

| Report | Lane / model | Result |
|---|---|---|
| `start-transcription-live-cerebras.report.json` | LIVE Cerebras `gpt-oss-120b` (first-class cerebras mode) | **failed (honest)** — model answered REPLY, literally "transcribing" by echoing its provider context instead of calling `START_TRANSCRIPTION` |
| `vision-set-mode-live-cerebras.report.json` | LIVE Cerebras `gpt-oss-120b` | **failed (honest)** — model replied "Vision mode turned off." **without calling the VISION action** (claims done, did nothing — the exact larp class the assertions exist to catch) |
| `start-transcription-deterministic.report.json` | deterministic-llm-proxy | **passed** — real `START_TRANSCRIPTION` executed, voice-control command delivered on the AGENT_EVENT bus |
| `vision-set-mode-deterministic.report.json` | deterministic-llm-proxy | **passed** — real `VISION` set_mode executed against the live in-process VisionService |

Reading: the action pipelines themselves are sound (deterministic lane drives the REAL actions/services and passes); the live-lane failures are genuine live-routing gaps for these two actions with gpt-oss-120b (also reproduced with a real-OpenAI-key run for start-transcription), consistent with previously documented live-routing failure modes. The failing live reports are kept deliberately — they are the real model trajectories, not a mock, and they document a real routing gap.

## Harness fixes required to get the live runs at all (this session)

- `plugins/plugin-discord` dist was stale (only `.d.ts` under `dist/user-account-scraper/`, no `.js`) → scenario boot fatal `Cannot find module '@elizaos/plugin-discord/user-account-scraper'`. Fixed by rebuild.
- `packages/scenario-runner/dist/` was stale (predated the `autoLoaded` requires-gate fix in `src/executor.ts`), so the live lane **skipped** `local-inference.start-transcription` with a false "required plugin(s) not registered" (plugin name `eliza-local-inference` ≠ normalized `local-inference`, and the successful auto-load was not tracked). Fixed by `bun run --cwd packages/scenario-runner build`.
