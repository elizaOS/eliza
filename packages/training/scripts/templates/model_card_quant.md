---
base_model: {base_hf_id}
library_name: transformers
license: apache-2.0
pipeline_tag: text-generation
tags:
  - eliza
  - elizaos
  - eliza-1
  - apollo
  - sft
  - {quant}
  - quantized
{extra_tags}---

# {eliza_short_name} ({quant})

> {quant_short_name} weights for the [`{base_eliza_repo_id}`](https://huggingface.co/{base_eliza_repo_id}) full-precision Eliza fine-tune.

## What is this

{quant_blurb}

| field | value |
|-------|-------|
| Quantization scheme | {quant_scheme_name} |
| Bit-width (weights) | {quant_bits_weights} |
| Bit-width (KV cache) | {quant_bits_kv} |
| Reference paper | {quant_paper} |
| Sibling base repo | [`{base_eliza_repo_id}`](https://huggingface.co/{base_eliza_repo_id}) |
| Recommended runtime | {quant_runtime} |
| Approximate file size | {quant_file_size} |
| Target hardware | {quant_target_hw} |
| Expected quality regression vs base | {quant_quality_delta} |

## Inference

{quant_inference_block}

## Provenance

- Source bf16 weights: [`{base_eliza_repo_id}`](https://huggingface.co/{base_eliza_repo_id})
- Calibration data (where applicable): held-out validation split of
  [`elizaos/eliza-toon-v1-sft`](https://huggingface.co/datasets/elizaos/eliza-toon-v1-sft).
- Training pipeline + quantization scripts:
  [`elizaos/eliza-1-pipeline`](https://huggingface.co/elizaos/eliza-1-pipeline)
  (`scripts/quantization/`).

## Evaluation

Evaluated against the base bf16 sibling. Numbers below are absolute scores on
the eliza-1 evaluation suite; subtract from the base card's scores for the
regression delta.

{eval_table}

## License

Apache-2.0, inherited from the base
checkpoint recorded in the sibling model metadata. Same terms as the
[`{base_eliza_repo_id}`](https://huggingface.co/{base_eliza_repo_id}) sibling.
