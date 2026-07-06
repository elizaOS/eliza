# @elizaos/plugin-pii-guard

Supplies a **local NER model recognizer** to the `@elizaos/core` PII
pseudonymization layer. This is the heavy-model half of the seam defined in
`packages/core/src/security/entity-recognizer.ts` — `@elizaos/core` never
hard-depends on an ONNX runtime, so the transformers.js + `onnxruntime-node`
dependency lives here and is injected at runtime through a service.

## What it does

- Registers a `Service` under the core service type
  `pii_entity_recognizer` (`PII_ENTITY_RECOGNIZER_SERVICE`).
- The service exposes a `PiiEntityRecognizer` (`getRecognizer()`), which the
  runtime composes with its built-in regex recognizer when PII swap is enabled.
- The recognizer runs a local **`dslim/distilbert-NER`** token-classification
  model and returns typed `EntitySpan[]` for **person / org / location**.
  Email / phone / address are handled by core's regex recognizer — not here.

## Model

- **`dslim/distilbert-NER`** — license **Apache-2.0**. Ships a first-party
  `onnx/` folder with only an **fp32** `model.onnx` (no quantized variant), so we
  load `dtype: 'fp32'`.
- Labels: CoNLL BIO — `O, B/I-MISC, B/I-PER, B/I-ORG, B/I-LOC`. We keep
  `PER → person`, `ORG → org`, `LOC → location` (via core's `canonicalKind`) and
  **drop `MISC`/`O`** (`MISC` is too noisy for PII).
- Runtime: `@huggingface/transformers` (transformers.js **v3**, not
  `@xenova/transformers`). In Node it runs on `onnxruntime-node` (native CPU)
  automatically. Model weights are cached under
  `${ELIZA_STATE_DIR}/local-inference/models` (shared with other local models).

## How it plugs into the core PII swap layer

1. Core's `PseudonymSession` owns the surrogate vault and value-based
   substitution/restoration. It does **not** decide what is a person / org /
   location — a `PiiEntityRecognizer` does.
2. When `ELIZA_PII_SWAP_ENABLED` is set, the runtime looks up
   `PII_ENTITY_RECOGNIZER_SERVICE`, calls `getRecognizer()`, and composes the
   returned recognizer with its regex recognizer (`CompositeEntityRecognizer`).
3. This plugin's service loads the model **in the background at boot** (never
   blocking boot). `getRecognizer()` returns the recognizer immediately (its
   `recognize()` awaits model readiness internally) or `null` if the load
   failed — in which case the layer degrades to regex-only.

## The transformers.js `#359` offset caveat

transformers.js `token-classification` frequently returns `start`/`end` as
`null` for BERT tokenizers, and the grouped `word` can carry `##` subword joins
and stray leading spaces. So we **never trust the pipeline's offsets or `word`**
for the emitted value. `relocateEntities(text, groups)` re-locates each grouped
result in the SOURCE text with a forward-moving cursor (`indexOf` from the end of
the previous match, with a whitespace-insensitive fallback), and the emitted
`EntitySpan.value` is the **exact substring sliced from the source** — which is
what lets the value-based pseudonymizer match real text. Groups that cannot be
located are dropped, never emitted with a guessed offset. Input longer than the
model's 512-token window is chunked (~1600-char overlapping windows) and results
are re-based onto the full text.

## Env / config (`agentConfig.pluginParameters`)

- `ELIZA_PII_SWAP_ENABLED` — read by **core**, not this plugin. Enables the PII
  swap layer that consumes this recognizer.
- `ELIZA_PII_NER_MODEL` — override the model id (default `dslim/distilbert-NER`).
- `ELIZA_PII_NER_SCORE_THRESHOLD` — minimum confidence `0..1` for an emitted
  span (default `0.5`). Invalid values are ignored with a warning.

## Layout

```
src/
  ner-recognizer.ts   NerEntityRecognizer (lazy pipeline load; injectable factory)
                      + relocateEntities / normalizeGroupedWord / chunkText (pure, unit-tested)
  service.ts          PiiGuardService (Service subclass; serviceType = pii_entity_recognizer)
  index.ts            piiGuardPlugin (Plugin) + re-exports
  relocate.test.ts        unit test of relocateEntities/chunkText (no download)
  ner-recognizer.test.ts  unit test of NerEntityRecognizer via an injected fake pipeline (no download)
  ner-recognizer.real.test.ts  REAL model load + run; skips gracefully offline
```

## Commands

```bash
bun run --cwd plugins/plugin-pii-guard build       # bun build.ts (shared driver), node ESM + d.ts
bun run --cwd plugins/plugin-pii-guard typecheck   # tsgo --noEmit
bun run --cwd plugins/plugin-pii-guard test        # vitest (unit only — *.real.test.ts excluded)
bun run --cwd plugins/plugin-pii-guard lint        # biome check --write
```

Run the real model test explicitly (downloads ~250MB on first run; skips if
offline):

```bash
bunx vitest run src/ner-recognizer.real.test.ts \
  --config plugins/plugin-pii-guard/vitest.config.real.ts   # or override the exclude
```

Repo-wide rules (logger-only, ESM, naming, evidence standard) are in the root
[AGENTS.md](../../AGENTS.md) / [AGENTS.md](../../AGENTS.md).
