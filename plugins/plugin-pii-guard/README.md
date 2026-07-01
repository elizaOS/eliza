# @elizaos/plugin-pii-guard

A local named-entity-recognition (NER) model recognizer for the elizaOS runtime's
**PII pseudonymization** layer. It supplies the "person / organization / location"
detector that the core PII swap layer composes with its built-in regex recognizer.

`@elizaos/core` deliberately never depends on an ONNX runtime, so the heavy model
dependency lives in this plugin and is injected at runtime via a service.

## Model

- **`dslim/distilbert-NER`** — **Apache-2.0**. A DistilBERT model fine-tuned on
  CoNLL-2003 for English NER. It natively covers PERSON, ORG, and LOCATION.
- Runs via **`@huggingface/transformers`** (transformers.js **v3**), which uses
  **`onnxruntime-node`** (native CPU) in Node automatically. Loaded as
  **fp32** because the model's first-party `onnx/` folder has no quantized
  variant.
- Weights are cached under `${ELIZA_STATE_DIR}/local-inference/models` so PII
  downloads share the same on-disk store as other local models.

Email, phone, and street-address PII are handled separately by core's
dependency-free regex recognizer — this plugin does not touch them. `MISC`
entities are dropped as too noisy for PII.

## How it plugs in

The plugin registers a `Service` under the core service type
`pii_entity_recognizer`. When PII swap is enabled in the runtime
(`ELIZA_PII_SWAP_ENABLED`), core looks up that service, calls `getRecognizer()`,
and composes the returned recognizer with its regex recognizer. The model loads
in the background at boot and never blocks it; until it is ready `getRecognizer()`
still returns the recognizer (its `recognize()` awaits readiness), and if the
load fails the layer degrades to regex-only.

## Configuration

| Env var | Owner | Default | Purpose |
| --- | --- | --- | --- |
| `ELIZA_PII_SWAP_ENABLED` | **core** | off | Enables the PII swap layer that consumes this recognizer. |
| `ELIZA_PII_NER_MODEL` | this plugin | `dslim/distilbert-NER` | Override the token-classification model id. |
| `ELIZA_PII_NER_SCORE_THRESHOLD` | this plugin | `0.5` | Minimum confidence (0..1) for an emitted span. |

## The offset caveat (transformers.js issue #359)

transformers.js token-classification pipelines frequently return `start`/`end`
as `null` for BERT tokenizers, and the grouped `word` can carry `##` subword
joins and stray spaces. This plugin therefore re-derives char offsets against the
source text itself and emits the **exact source substring** as the entity value
(never the pipeline's possibly-mangled `word`), which is what lets the
value-based pseudonymizer match real text. See `CLAUDE.md` for details.

## Scripts

```bash
bun run build       # node ESM bundle + d.ts
bun run typecheck   # tsgo --noEmit
bun run test        # vitest (unit tests only; the real-model test is excluded)
bun run lint        # biome
```

## License

MIT (this plugin). The bundled model `dslim/distilbert-NER` is Apache-2.0.
