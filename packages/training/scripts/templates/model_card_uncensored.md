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
  - abliterated
  - uncensored
  - research
---

# {eliza_short_name}-uncensored

> **Research / red-teaming only.** Safety alignment has been removed from this
> checkpoint via directional refusal ablation. Do not deploy as a public-facing
> assistant without re-aligning.

## Safety disclaimer

This model is the **abliterated** sibling of
[`{base_eliza_repo_id}`](https://huggingface.co/{base_eliza_repo_id}). The
single-direction refusal mediator (Arditi et al., [arXiv:2406.11717](https://arxiv.org/abs/2406.11717))
has been orthogonalized out of the residual-stream writers using
[Heretic](https://github.com/p-e-w/heretic) (TPE-optimized direction ablation
on `self_attn.o_proj` for full-attention layers + `mlp.down_proj` for all
layers). The result is a model that no longer refuses harmful requests it was
previously RLHF-tuned to refuse.

This release exists for legitimate red-team / safety-research / interpretability
work. It is published in the same `elizaos` HuggingFace organization as the
safety-tuned line, distinguished by the `-uncensored` suffix in the repo name.
Use of this model in production-facing deployments without an additional
alignment pass is **strongly discouraged**.

By downloading these weights you agree that you will not use them for any of
the categories prohibited by the upstream base model's
[acceptable-use policy](https://huggingface.co/{base_hf_id}/blob/main/LICENSE).
The
abliteration removed Eliza's *refusal capability*; it did not relax the
underlying license.

## Abliteration metadata

| field | value |
|-------|-------|
| Source SFT checkpoint | [`{base_eliza_repo_id}`](https://huggingface.co/{base_eliza_repo_id}) |
| Tool | [`heretic-llm`](https://pypi.org/project/heretic-llm/) ≥ v1.2 |
| Refusal direction layer | {abl_layer} (= int(0.6 * n_layers)) |
| Refusal rate (held-out 50-prompt probe) | {abl_refusal_rate} |
| KL divergence vs SFT (256 harmless prompts) | {abl_kl} |
| Calibration set (harmful) | [`mlabonne/harmful_behaviors`](https://huggingface.co/datasets/mlabonne/harmful_behaviors) train split |
| Calibration set (harmless) | [`mlabonne/harmless_alpaca`](https://huggingface.co/blog/mlabonne/abliteration) (256 prompts) |
| TPE trials | {abl_tpe_trials} |
| heretic params | see `heretic_params.json` in this repo |

## Capability evaluation (vs SFT base)

Eval gates that must pass for this checkpoint to ship:

- MMLU regression vs SFT: ≤ 1pp
- GSM8K regression vs SFT: ≤ 2pp
- Refusal probe (50 held-out harmful prompts): ≤ 5%
- KL on 256 harmless prompts: ≤ 0.10

{eval_table}

## Inference

```python
from transformers import AutoModelForCausalLM, AutoTokenizer
import torch

tok = AutoTokenizer.from_pretrained("{repo_id}")
model = AutoModelForCausalLM.from_pretrained(
    "{repo_id}", torch_dtype=torch.bfloat16, device_map="auto",
)
```

## License

Apache-2.0, inherited from the base
checkpoint recorded in the sibling model metadata. Apache-2.0 explicitly
permits derivative works including modified weights. The abliteration removed
the safety-alignment behavior but did not change the license terms.

**License carve-out:** This release is distributed under Apache-2.0 *with* the
explicit understanding that:

1. The model is intended for research and red-teaming. No safety guarantees
   apply.
2. Users assume full responsibility for downstream deployments.
3. Re-distribution must preserve the safety disclaimer + abliteration metadata
   in the model card.

## Citation

```bibtex
@misc{{eliza1_uncensored_{eliza_citation_key},
  title  = {{ {eliza_short_name}-uncensored: an abliterated Eliza checkpoint for safety research }},
  author = {{ elizaOS team }},
  year   = {{ 2026 }},
  url    = {{ https://huggingface.co/{repo_id} }},
}}

@misc{{arditi2024refusal,
  title         = {{ Refusal in Language Models Is Mediated by a Single Direction }},
  author        = {{ Arditi, Andy and Obeso, Oscar and Sye, Aaquib and Paleka, Daniel and Panickssery, Nina and Gurnee, Wes and Nanda, Neel }},
  year          = {{ 2024 }},
  eprint        = {{ 2406.11717 }},
  archivePrefix = {{ arXiv }},
  primaryClass  = {{ cs.LG }},
}}
```
