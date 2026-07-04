# #11913 — bionic host: honor maxTokens per native call + real incremental streaming

Fix evidence for issue #11913 (filed from the #11734 Pixel 6a bench rows,
`.github/issue-evidence/11734-pixel6a-adb-rows/`).

## Where `stream_next` actually lives (the issue asked to locate + report)

- **C implementation:** `eliza_inference_llm_stream_next` in the elizaOS
  llama.cpp fork — `tools/omnivoice/src/eliza-inference-ffi.cpp` at the
  recorded gitlink `299d5b78bc58dc9784667d2c8662b6c4beebf5e9`
  (`plugins/plugin-local-inference/native/llama.cpp`). It is **not broken**:
  each call decodes at most `min(tokens_cap, stream max_tokens remaining)`
  tokens and stops at EOS/EOG (both the plain and the MTP path). A reference
  copy of the same contract is embedded in
  `packages/app-core/scripts/omnivoice-fuse/prepare.mjs`.
- **The broken link (fixed here, app-side only — no fork change needed):**
  the JNI wrapper `Java_ai_elizaos_app_ElizaVoiceNative_nativeLlmStreamNext`
  (`packages/app-core/platforms/android/app/src/main/elizavoice-jni/elizavoice-jni.cpp`)
  hardcoded `tokens_cap = 256` (its full token buffer), and the resident
  stream is opened with `max_tokens = 2048` — so ONE native call decoded up to
  256 tokens. The Java host's `while (produced < cap)` check
  (`ElizaBionicInferenceServer.java`) only ran *after* that call, i.e. after
  ~256 tokens ≈ 46 s of decode on the Pixel 6a, and the "streaming" op emitted
  the whole reply as one giant frame (TTFT == full-turn latency).

## The fix

1. `nativeLlmStreamNext(long, int maxStepTokens)` — the per-call token budget
   is now a parameter, clamped to `[1, 256]`, passed straight through as
   `tokens_cap`.
2. `BionicDecodeLoop` (new, pure JVM) owns the per-turn accounting used by
   BOTH host ops: every native call is budgeted `min(step, cap − produced)`,
   so a `maxTokens: 20` turn performs ≤ 20 tokens of eval work, exactly.
   - buffered `op="generate"`: step = 256 (single bounded call for small caps);
   - streaming `op="generateStream"`: step = per-request `streamStep` →
     `ELIZA_BIONIC_STREAM_STEP` env → 8 (the #9174 user-visible streaming
     knee), so token frames flow at token cadence and TTFT decouples.
3. Agent side threads the knob + gains real streaming:
   - `plugin-capacitor-bridge` `makeGenerateHandler` sends `streamStep` from
     `ELIZA_LOCAL_STREAM_TOKENS_PER_STEP` (the existing shared knob) on the
     streaming path (it already used `op="generateStream"`);
   - `plugin-local-inference` `BionicHostLoader.generate` now accepts
     `onTextChunk` (+ `maxTokensPerStep`) and switches to the server-push
     `op="generateStream"` wire shape — previously it always buffered, so
     chat through the AOSP loader path had single-chunk SSE.
4. The host logs the eval count per turn
   (`GENERATE… eval count: N tok (maxTokens cap M)`) so future device rows can
   assert the cap from logcat alone.

## Regression gates (host-side, per the issue's ask #3)

- `TEST-ai.elizaos.app.BionicDecodeLoopTest.xml` — JVM JUnit run (gradle
  `:app:testDebugUnitTest`, JDK 21, `ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1`):
  **14/14 pass**, including
  `maxTokens20PerformsAtMost20TokensOfEvalWork` — a scripted native step fn
  records every requested per-call budget; a `maxTokens=20` turn requests
  exactly `[20]` (buffered) / `[8, 8, 4]` (streaming, step 8) and total
  decoded == 20. Also covers EOS early-stop, cap-boundary done, frame order,
  zero-progress termination, step/sink failure propagation, and the
  `streamStep` request→env→default→clamp resolution.
- `vitest-bionic-host-loader.txt` — real abstract-UDS contract tests
  (no mocks; an actual AF_UNIX server speaking the host's framing):
  **20/20 pass**, including the new streaming coverage: `op=generateStream` +
  `maxTokens`/`streamStep` threading, chunk arrival order (sync + async
  consumers), buffered fallback when no callback, `ok:false` done frame,
  mid-stream close, and a throwing consumer rejecting the turn.
- `vitest-plugin-capacitor-bridge.txt` — **9 files / 53 tests pass**,
  including the new `resolveBionicStreamStep` knob tests.
- `gradle-run-summary.txt` — the gradle unit-test invocation result.
- Typecheck: `turbo run typecheck --filter=@elizaos/plugin-capacitor-bridge
  --filter=@elizaos/plugin-local-inference` → 60/60 tasks green.
- JNI: `elizavoice-jni.cpp` syntax-checked with NDK r29 clang++
  (`--target=aarch64-linux-android30 -fsyntax-only`) against the fork's
  `eliza-inference-ffi.h` at the recorded pin.

## Device re-verification

Rides the next device lane per the issue scope: re-run the #11734 bench rows
on the Pixel 6a and confirm (a) warm short-reply latency drops to
~prefill + cap×0.14 s, (b) logcat shows `eval count: ≤ maxTokens`, (c) SSE
chunks arrive incrementally (multiple `type:"token"` frames per turn).
