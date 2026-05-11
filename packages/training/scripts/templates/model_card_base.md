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
---

# {eliza_short_name}

> Local-first Eliza-1 agent checkpoint trained with APOLLO on the
> elizaOS TOON-format trajectory corpus.

`{eliza_short_name}` is a full-parameter SFT Eliza-1 checkpoint trained on
[`elizaos/eliza-toon-v1-sft`](https://huggingface.co/datasets/elizaos/eliza-toon-v1-sft).
Trained with [APOLLO](https://arxiv.org/abs/2412.05270) (full fine-tune at
SGD-like memory) using the
[`elizalabs/eliza-1-pipeline`](https://huggingface.co/elizalabs/eliza-1-pipeline)
repo. Upstream lineage is recorded in the model metadata and license block.

## Model description

| field | value |
|-------|-------|
| Upstream lineage | recorded in `base_model` metadata |
| Parameters | {params_billion}B |
| Architecture | Eliza-1 hybrid local-inference backbone |
| Training data | [`elizaos/eliza-toon-v1-sft`](https://huggingface.co/datasets/elizaos/eliza-toon-v1-sft) |
| Training pipeline | [`elizalabs/eliza-1-pipeline`](https://huggingface.co/elizalabs/eliza-1-pipeline) |
| Optimizer | {optimizer} (rank {optimizer_rank}) |
| Train sequence length | {seq_len} |
| Native context window | {infer_max_in_plus_out} tokens ({infer_max_in} in + {infer_max_out} out) |
| License | Apache-2.0 (inherited from base) |

## Inference

### transformers (bf16)

```python
from transformers import AutoModelForCausalLM, AutoTokenizer
import torch

tok = AutoTokenizer.from_pretrained("{repo_id}")
model = AutoModelForCausalLM.from_pretrained(
    "{repo_id}", torch_dtype=torch.bfloat16, device_map="auto",
)
```

### vLLM

Use the in-repo serve script
[`scripts/inference/serve_vllm.py`](https://huggingface.co/elizalabs/eliza-1-pipeline/blob/main/scripts/inference/serve_vllm.py)
or invoke vLLM directly:

```bash
vllm serve {repo_id} --max-model-len {infer_max_in_plus_out}
```

### milady

Drop the model alias into your milady config and the runtime will pick it up:

```bash
MILADY_LOCAL_MODEL={repo_id} milady run
```

## Training

{training_table}

## Evaluation

{eval_table}

## License

Apache-2.0, inherited from the upstream base checkpoint recorded in
`base_model`.
Eliza-side weights and training pipeline released under the same license; see
<https://github.com/elizaOS> for source. Use of the model is additionally
governed by the upstream acceptable-use policy inherited via the base
checkpoint.

## Citation

```bibtex
@misc{{eliza1_{eliza_citation_key},
  title  = {{ {eliza_short_name}: an elizaOS local-first agent }},
  author = {{ elizaOS team }},
  year   = {{ 2026 }},
  url    = {{ https://huggingface.co/{repo_id} }},
}}
```
