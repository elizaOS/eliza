# Follow-up: force the structured envelope on the FFI streaming backend (GBNF)

## Why

Local-model chat streams token-by-token via the structured stream extractor,
which parses the reply (`replyText`) out of a JSON envelope as tokens arrive.
On the **dev backend** (`NodeLlamaCppBackend`) the GBNF grammar is applied
(`session.prompt({ grammar, onTextChunk })`), so the envelope is well-formed and
the extractor surfaces `replyText` deltas.

The **production FFI backend** (`FfiStreamingBackend`, used on desktop + mobile)
streams raw tokens but **cannot apply a grammar** — the native streaming surface
has no grammar field (`eliza_llm_stream_config_t` in `ffi-streaming-llm.h` has
`max_tokens`, `temperature`, `prompt_cache_key`, `draft_max`, … but no `grammar`
/ `gbnf`). So the envelope is never *forced*.

This is largely mitigated already: `ResponseSkeletonStreamExtractor` now streams
non-envelope prose straight through as the reply (commit "fix(core): stream
local-model chat replies token-by-token"). The remaining gap is a model that
emits a **malformed envelope** on FFI (starts with `{` but isn't parseable) —
that still collapses to a single trailing chunk. Forcing the GBNF closes it.

## The change (requires a device build — cannot be validated on a CI host)

GBNF compilation already exists: `compileSkeletonToGbnf(skeleton)` in
`src/services/structured-output.ts:202` (and `resolveBindingGrammarSource` /
`StructuredGenerateParams.responseSkeleton`).

1. **C header** — `packages/app-core/scripts/ffi-stub/ffi-streaming-llm.h` (and
   the real header in the omnivoice tool): add a grammar field to
   `eliza_llm_stream_config_t`, e.g. `const char * gbnf_grammar; /* NULL ok */`.

2. **Native omnivoice C++** — `plugins/plugin-local-inference/native/llama.cpp/
   tools/omnivoice/` (the llama.cpp submodule): when `cfg->gbnf_grammar != NULL`,
   build a `llama_grammar` (llama.cpp's `llama_grammar_init_impl` / the
   `llama_sampler_init_grammar` chain) and add it to the per-session sampler
   chain. Tokens still emit one-by-one via the existing `on_token` callback —
   grammar only constrains sampling. Rebuild `libelizainference` (the omnivoice
   fuse).

3. **TS binding** — `src/services/llm-streaming-binding.ts`: add `gbnfGrammar?:
   string` to `LlmStreamConfig`; the `wrapElizaInferenceFfi` adapter forwards it
   to the native `llmStreamOpen` config.

4. **TS backend** — `src/services/ffi-streaming-backend.ts` `generateWithUsage`:
   compile the grammar from `args.responseSkeleton` (mirroring
   `NodeLlamaCppBackend.generate`'s `resolveBindingGrammarSource` →
   `compileSkeletonToGbnf`) and pass it through
   `runner.generateWithUsage({ …, gbnfGrammar })`; thread it in
   `src/services/ffi-streaming-runner.ts` (`FfiStreamingGenerateArgs` →
   `llmStreamOpen` config).

## Verification (device)

Load a small GGUF, send a chat turn through the FFI backend, and confirm (a) the
reply streams token-by-token in the UI and (b) the on-wire output is a
well-formed envelope (`thought`/`replyText`/`actions`) so the extractor takes
the structured path rather than the prose passthrough. The keyless wiring is
already guarded by `src/services/engine-streaming.test.ts` and
`src/services/structured-output.test.ts` (`compileSkeletonToGbnf`).
