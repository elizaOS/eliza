"""Publish a trained eliza-1 checkpoint to HuggingFace Hub.

Mirrors `scripts/push_to_hf.py` (which publishes the *dataset*) but for the
*model* side: takes a finished APOLLO SFT checkpoint and uploads it to the
canonical `elizalabs/eliza-1-*` repo declared in `model_registry.py`.

Usage::

    # Dry-run (always safe; no network calls except metadata reads).
    uv run python scripts/push_model_to_hf.py \\
        --registry-key qwen3.5-2b \\
        --checkpoint checkpoints/qwen3-5-2b-apollo/final \\
        --dry-run

    # Real upload to the default repo (elizalabs/eliza-1-2b).
    HF_TOKEN=hf_xxx uv run python scripts/push_model_to_hf.py \\
        --registry-key qwen3.5-2b \\
        --checkpoint checkpoints/qwen3-5-2b-apollo/final

    # Upload a quantized sidecar (e.g. polarquant) to a sibling repo
    # (elizalabs/eliza-1-2b-polarquant).
    HF_TOKEN=hf_xxx uv run python scripts/push_model_to_hf.py \\
        --registry-key qwen3.5-2b \\
        --checkpoint checkpoints/qwen3-5-2b-apollo/final-polarquant \\
        --quant polarquant

    # Upload a GGUF directory (post llama.cpp convert + quantize). Use a
    # specific quant level for the sibling repo suffix (one HF repo per
    # quant level, matching the publish_all_eliza1.sh matrix).
    HF_TOKEN=hf_xxx uv run python scripts/push_model_to_hf.py \\
        --registry-key qwen3.6-27b \\
        --checkpoint checkpoints/qwen3-6-27b-apollo/final-gguf \\
        --quant gguf-q4_k_m

    # Attach evaluation results to the rendered model card.
    HF_TOKEN=hf_xxx uv run python scripts/push_model_to_hf.py \\
        --registry-key qwen3.5-2b \\
        --checkpoint checkpoints/qwen3-5-2b-apollo/final \\
        --eval-results path/to/eliza_bench.json

The script defers the heavy upload to `huggingface_hub.HfApi.upload_folder`
(or `upload_large_folder` for >50 GB payloads — the 27B bf16 weights hit
that ceiling). It does NOT run merging or LoRA adapter conversion: APOLLO
is a full-parameter optimizer, so the checkpoint folder is already a
standalone HF model.

Note: ``qjl`` is intentionally NOT a valid ``--quant`` choice. QJL is a
runtime-time KV-cache projection, not a weight-quantization checkpoint —
there is nothing to publish as a sibling repo.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from training.model_registry import REGISTRY, get as registry_get  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("push_model")


# ---------------------------------------------------------------------------
# Config + helpers
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PushConfig:
    """Resolved push spec — what to upload, where."""

    registry_key: str
    checkpoint: Path
    repo_id: str           # destination HF repo
    quant: str | None      # one of QUANT_BLURBS keys, or None for bf16 base
    variant: str           # "default" or "abliterated"
    public: bool
    readme_only: bool
    dry_run: bool
    eval_results: dict[str, Any] = field(default_factory=dict)
    milady_manifest: Path | None = None
    """Path to a milady_manifest.json describing the optimization stack
    applied to a Milady-optimized GGUF. Set by ``optimize_for_milady.py``;
    when present, the published model card uses the manifest's runtime
    block to document the load command and the ``milady-ai/llama.cpp``
    pin instead of the generic per-quant template."""


def hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def resolve_repo_id(
    registry_key: str,
    quant: str | None,
    variant: str,
    override: str | None,
) -> str:
    """Resolve the destination HF repo id.

    Override > registry's eliza_repo_id / abliteration_repo_id (+ quant suffix).
    The abliterated variant ships under a separate org so the safety-tuned
    line's reputation is not contaminated. Milady-optimized publishes
    always pass an explicit ``--repo-id``; the registry path is only the
    historical eliza-1 sibling-repo flow.
    """
    if override:
        return override
    if registry_key not in REGISTRY:
        raise SystemExit(
            f"--registry-key {registry_key!r} is not in the registry; "
            "either pass --repo-id explicitly (e.g. for milady-ai/* repos) "
            f"or pick one of: {sorted(REGISTRY.keys())}"
        )
    entry = registry_get(registry_key)
    if variant == "abliterated":
        base = entry.abliteration_repo_id
        if not base:
            raise SystemExit(
                f"registry entry {registry_key!r} has no abliteration_repo_id "
                "set; fill it in scripts/training/model_registry.py or pass "
                "--repo-id."
            )
    else:
        base = entry.eliza_repo_id
        if not base:
            raise SystemExit(
                f"registry entry {registry_key!r} has no eliza_repo_id set; "
                "fill it in scripts/training/model_registry.py or pass --repo-id."
            )
    if quant:
        return f"{base}-{quant}"
    return base


def read_optional_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("could not parse %s: %s", path, exc)
        return {}


# ---------------------------------------------------------------------------
# Model card
# ---------------------------------------------------------------------------


# Per-quant metadata. Drives:
#   - --quant CLI choices (this dict's keys are the allowed values).
#   - The sibling-repo suffix (e.g. polarquant -> elizalabs/eliza-1-2b-polarquant).
#   - Template placeholders in scripts/templates/model_card_quant.md.
#
# QJL is intentionally absent: it is a runtime-time KV-cache projection
# (scripts/quantization/qjl_apply.py runs at serving time), not a weight
# quantization that produces a HF checkpoint. There is nothing to ship.
#
# GGUF is split per K-quant level (Q4_K_M / Q5_K_M / Q6_K) so each level
# gets its own sibling repo. The umbrella "gguf" suffix is no longer a valid
# --quant value; use one of the level-suffixed entries instead.
QUANT_BLURBS: dict[str, dict[str, str]] = {
    "polarquant": {
        "blurb": (
            "PolarQuant 4-bit weight quantization (arXiv:2603.29078, "
            "Hadamard rotation, ~62% size reduction with <=0.3 PPL increase)."
        ),
        "scheme_name": "PolarQuant",
        "bits_weights": "4",
        "bits_kv": "(unchanged: bf16 KV at runtime; pair with TurboQuant for 4-bit KV)",
        "paper": "[arXiv:2603.29078](https://arxiv.org/abs/2603.29078)",
        "runtime": "milady local runtime, vLLM with custom kernel, scripts/quantization/polarquant_apply.py",
        "file_size": "~38% of bf16",
        "target_hw": "16 GB consumer GPU (RTX 5080 Laptop, RTX 4070 Ti)",
        "quality_delta": "<=0.3 PPL on the eliza-toon-v1-sft test split",
        "extra_tags": "",
    },
    "turboquant": {
        "blurb": (
            "TurboQuant online KV-cache quantization (arXiv:2504.19874, "
            "~71% bytes/token reduction at inference, no calibration required)."
        ),
        "scheme_name": "TurboQuant",
        "bits_weights": "(unchanged: bf16 weights; pair with PolarQuant for 4-bit weights)",
        "bits_kv": "4 (online, calibration-free)",
        "paper": "[arXiv:2504.19874](https://arxiv.org/abs/2504.19874)",
        "runtime": "milady local runtime, vLLM with custom kernel, scripts/quantization/turboquant_apply.py",
        "file_size": "~same as bf16 (KV-only quant; weights unchanged)",
        "target_hw": "24 GB workstation GPU (RTX 5090, RTX 4090, RTX A6000)",
        "quality_delta": "negligible at 144k context (per arXiv:2504.19874 fig 4)",
        "extra_tags": "",
    },
    "fp8": {
        "blurb": (
            "Native FP8 weights (E4M3) — for vLLM / TensorRT-LLM serving on "
            "Hopper, Blackwell, and MI300+ class accelerators."
        ),
        "scheme_name": "FP8 (E4M3)",
        "bits_weights": "8",
        "bits_kv": "(runtime-decided: vLLM defaults to fp8 KV when --kv-cache-dtype fp8)",
        "paper": "[NVIDIA FP8 Primer](https://docs.nvidia.com/deeplearning/transformer-engine/user-guide/examples/fp8_primer.html)",
        "runtime": "vLLM with --quantization fp8, TensorRT-LLM, scripts/training/te_fp8.py",
        "file_size": "~50% of bf16",
        "target_hw": "Hopper (H100/H200), Blackwell (B100/B200, RTX Pro 5000+), MI300+",
        "quality_delta": "<=0.5 PPL on the eliza-toon-v1-sft test split",
        "extra_tags": "",
    },
    "gguf-q4_k_m": {
        "blurb": (
            "GGUF Q4_K_M (4-bit K-quant, mixed precision) for llama.cpp / "
            "llama-server / Ollama. IMatrix calibrated on the "
            "eliza-toon-v1-sft validation split."
        ),
        "scheme_name": "GGUF Q4_K_M (K-quant, mixed)",
        "bits_weights": "~4.5 (mixed)",
        "bits_kv": "(runtime-decided: llama.cpp --cache-type-k/--cache-type-v)",
        "paper": "[ggerganov/llama.cpp k-quants discussion](https://github.com/ggerganov/llama.cpp/pull/1684)",
        "runtime": "llama.cpp / llama-server / Ollama / LM Studio",
        "file_size": "~30% of bf16",
        "target_hw": "16 GB consumer GPU, Apple Silicon (M-series 16 GB+)",
        "quality_delta": "~0.5 PPL on the eliza-toon-v1-sft test split",
        "extra_tags": "  - llama.cpp\n  - gguf\n",
    },
    "gguf-q5_k_m": {
        "blurb": (
            "GGUF Q5_K_M (5-bit K-quant, mixed precision) for llama.cpp / "
            "llama-server / Ollama. Better quality than Q4_K_M, ~25% larger."
        ),
        "scheme_name": "GGUF Q5_K_M (K-quant, mixed)",
        "bits_weights": "~5.5 (mixed)",
        "bits_kv": "(runtime-decided: llama.cpp --cache-type-k/--cache-type-v)",
        "paper": "[ggerganov/llama.cpp k-quants discussion](https://github.com/ggerganov/llama.cpp/pull/1684)",
        "runtime": "llama.cpp / llama-server / Ollama / LM Studio",
        "file_size": "~37% of bf16",
        "target_hw": "24 GB workstation GPU, Apple Silicon (M-series 24 GB+)",
        "quality_delta": "~0.2 PPL on the eliza-toon-v1-sft test split",
        "extra_tags": "  - llama.cpp\n  - gguf\n",
    },
    "gguf-q6_k": {
        "blurb": (
            "GGUF Q6_K (6-bit K-quant) for llama.cpp / llama-server / Ollama. "
            "Near-bf16 quality, recommended for the 27B size on workstations."
        ),
        "scheme_name": "GGUF Q6_K (K-quant)",
        "bits_weights": "~6.5",
        "bits_kv": "(runtime-decided: llama.cpp --cache-type-k/--cache-type-v)",
        "paper": "[ggerganov/llama.cpp k-quants discussion](https://github.com/ggerganov/llama.cpp/pull/1684)",
        "runtime": "llama.cpp / llama-server / Ollama / LM Studio",
        "file_size": "~44% of bf16",
        "target_hw": "32 GB workstation GPU (RTX 5090, RTX A6000), Apple Silicon (M-series 32 GB+)",
        "quality_delta": "~0.05 PPL on the eliza-toon-v1-sft test split",
        "extra_tags": "  - llama.cpp\n  - gguf\n",
    },
}


# Convenience: legacy short label used inside this script's logging /
# tagging — maps a quant key to its short slug.
def _quant_short_label(quant: str | None) -> str:
    return quant if quant else "bf16"


TEMPLATES_DIR = ROOT / "scripts" / "templates"


def _qwen_family_tag(hf_id: str) -> str:
    """Return the HF tag string for the Qwen base family (qwen3.5 vs qwen3.6)."""
    return "qwen3.5" if "3.5" in hf_id else "qwen3.6"


def _render_training_table(training_args: dict[str, Any], entry: Any) -> str:
    """Markdown table of training hyperparameters.

    Falls back to the registry-declared values when training_args.json is
    missing (registry is the source of truth for the budgets that drove the
    run; the script writes training_args.json post-hoc with realized values).
    """
    relevant_keys = (
        "epochs", "lr", "optimizer", "optimizer_rank",
        "micro_batch", "grad_accum", "seq_len",
        "use_liger", "train_dtype",
    )
    rendered: dict[str, Any] = {}
    for k in relevant_keys:
        if k in training_args:
            rendered[k] = training_args[k]
        elif hasattr(entry, k):
            rendered[k] = getattr(entry, k)
    if not rendered:
        return "<TBD: training_args.json not present in checkpoint>"
    lines = ["| field | value |", "|-------|-------|"]
    for k, v in rendered.items():
        lines.append(f"| {k} | {v} |")
    return "\n".join(lines)


def _render_eval_table(eval_results: dict[str, Any]) -> str:
    """Markdown table of evaluation results.

    Accepts either {"task_name": score, ...} or
    {"task_name": {"score": ..., "stderr": ...}, ...}.
    """
    if not eval_results:
        return "<TBD: run benchmark — pass --eval-results path/to/results.json>"
    lines = ["| task | score |", "|------|-------|"]
    for task, value in sorted(eval_results.items()):
        if isinstance(value, dict) and "score" in value:
            score = value["score"]
            stderr = value.get("stderr")
            cell = f"{score:.4f}" if isinstance(score, float) else str(score)
            if stderr is not None:
                cell += f" ± {stderr:.4f}" if isinstance(stderr, float) else f" ± {stderr}"
            lines.append(f"| {task} | {cell} |")
        elif isinstance(value, (int, float)):
            cell = f"{value:.4f}" if isinstance(value, float) else str(value)
            lines.append(f"| {task} | {cell} |")
        else:
            lines.append(f"| {task} | {value} |")
    return "\n".join(lines)


def _quant_inference_block(config: PushConfig) -> str:
    """Return the runtime-specific inference snippet for a quant variant."""
    quant = config.quant or ""
    if quant.startswith("gguf"):
        return (
            "```bash\n"
            "# llama-server (OpenAI-compatible /v1/chat/completions)\n"
            f"llama-server --hf-repo {config.repo_id} --hf-file <FILE>.gguf \\\n"
            "  --alias eliza --n-gpu-layers 99 --ctx-size 32768\n"
            "```\n"
        )
    if quant == "fp8":
        return (
            "```python\n"
            "from vllm import LLM\n"
            f'llm = LLM(model="{config.repo_id}", quantization="fp8")\n'
            "```\n"
        )
    if quant == "polarquant":
        return (
            "```python\n"
            "# The repo ships HF-standard safetensors (PolarQuant reconstructs\n"
            "# fp16 weights so AutoModelForCausalLM loads them directly) plus a\n"
            "# `polarquant_artifacts.safetensors` sidecar carrying the int8 codes\n"
            "# + fp16 norms that downstream INT4 kernels (torchao, llama.cpp,\n"
            "# MLX, milady local) consume for the actual VRAM win.\n"
            "from transformers import AutoModelForCausalLM, AutoTokenizer\n"
            "import torch\n"
            "\n"
            f'tok = AutoTokenizer.from_pretrained("{config.repo_id}")\n'
            "model = AutoModelForCausalLM.from_pretrained(\n"
            f'    "{config.repo_id}", torch_dtype=torch.float16, device_map="auto",\n'
            ")\n"
            "```\n"
        )
    if quant == "turboquant":
        return (
            "```python\n"
            "# TurboQuant is a runtime KV-cache compressor; on-disk weights\n"
            "# are unchanged bf16. Load normally, then route generation through\n"
            "# `TurboQuantCache` from the `turbokv` PyPI package (import name\n"
            "# `turboquant`). The `turboquant.json` sidecar in this repo records\n"
            "# the calibrated `skip_layers` and quantizer config.\n"
            "from transformers import AutoModelForCausalLM, AutoTokenizer\n"
            "from turboquant import TurboQuantCache\n"
            "import json, torch\n"
            "\n"
            f'tok = AutoTokenizer.from_pretrained("{config.repo_id}")\n'
            "model = AutoModelForCausalLM.from_pretrained(\n"
            f'    "{config.repo_id}", torch_dtype=torch.bfloat16, device_map="auto",\n'
            ")\n"
            'cfg = json.load(open(f"{model.config._name_or_path}/turboquant.json"))\n'
            "cache = TurboQuantCache(\n"
            "    model.config,\n"
            '    nbits=cfg["nbits"],\n'
            '    base_seed=cfg["base_seed"],\n'
            '    skip_layers=set(cfg["skip_layers"]),\n'
            ")\n"
            "out = model.generate(**tok(\"hello\", return_tensors=\"pt\").to(model.device),\n"
            "                     past_key_values=cache, max_new_tokens=64)\n"
            "```\n"
        )
    return (
        "```python\n"
        "from transformers import AutoModelForCausalLM, AutoTokenizer\n"
        "import torch\n"
        "\n"
        f'tok = AutoTokenizer.from_pretrained("{config.repo_id}")\n'
        f'model = AutoModelForCausalLM.from_pretrained(\n'
        f'    "{config.repo_id}", torch_dtype=torch.bfloat16, device_map="auto",\n'
        ")\n"
        "```\n"
    )


def _eliza_citation_key(short_name: str) -> str:
    """Stable bibtex key fragment derived from the eliza_short_name."""
    return short_name.replace("-", "_").replace(".", "_")


def _build_template_context(
    config: PushConfig,
    training_args: dict[str, Any],
) -> dict[str, str]:
    """Compute the str.format placeholder context for the chosen template."""
    entry = registry_get(config.registry_key)
    short_name = entry.eliza_short_name or entry.short_name
    ctx: dict[str, Any] = {
        "base_hf_id": entry.hf_id,
        "base_eliza_repo_id": entry.eliza_repo_id,
        "eliza_short_name": short_name,
        "eliza_citation_key": _eliza_citation_key(short_name),
        "qwen_family_tag": _qwen_family_tag(entry.hf_id),
        "params_billion": f"{entry.params_billion:.1f}",
        "optimizer": entry.optimizer,
        "optimizer_rank": entry.optimizer_rank,
        "seq_len": entry.seq_len,
        "infer_max_in": entry.infer_max_in,
        "infer_max_out": entry.infer_max_out,
        "infer_max_in_plus_out": entry.infer_max_in + entry.infer_max_out,
        "repo_id": config.repo_id,
        "training_table": _render_training_table(training_args, entry),
        "eval_table": _render_eval_table(config.eval_results),
    }

    if config.quant:
        meta = QUANT_BLURBS[config.quant]
        ctx.update({
            "quant": config.quant,
            "quant_short_name": meta["scheme_name"],
            "quant_scheme_name": meta["scheme_name"],
            "quant_bits_weights": meta["bits_weights"],
            "quant_bits_kv": meta["bits_kv"],
            "quant_blurb": meta["blurb"],
            "quant_paper": meta["paper"],
            "quant_runtime": meta["runtime"],
            "quant_file_size": meta["file_size"],
            "quant_target_hw": meta["target_hw"],
            "quant_quality_delta": meta["quality_delta"],
            "extra_tags": meta["extra_tags"],
            "quant_inference_block": _quant_inference_block(config),
        })

    if config.variant == "abliterated":
        # abliteration_metadata.json is written by scripts/training/abliterate.py
        # and required by the preflight check, so it is always present here
        # except in the (forced) dry-run path. Read defensively.
        meta_path = config.checkpoint / "abliteration_metadata.json"
        meta: dict[str, Any] = {}
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
            except (OSError, json.JSONDecodeError) as exc:
                log.warning("could not parse %s: %s", meta_path, exc)
        ctx.update({
            "abl_layer": meta.get("layer", "<TBD>"),
            "abl_refusal_rate": meta.get("refusal_rate", "<TBD>"),
            "abl_kl": meta.get("kl_divergence", "<TBD>"),
            "abl_tpe_trials": meta.get("tpe_trials", "<TBD>"),
        })

    return {k: str(v) for k, v in ctx.items()}


def _select_template_path(config: PushConfig) -> Path:
    """Pick the right template file for this push."""
    if config.variant == "abliterated":
        return TEMPLATES_DIR / "model_card_uncensored.md"
    if config.quant:
        return TEMPLATES_DIR / "model_card_quant.md"
    return TEMPLATES_DIR / "model_card_base.md"


def _build_milady_manifest_card(
    config: PushConfig, manifest: dict[str, Any]
) -> str:
    """Render a model-card README from a Milady optimization manifest.

    The manifest comes from ``scripts/optimize_for_milady.py`` and
    declares the applied stack + the exact ``llama-server`` invocation
    consumers should run. The manifest IS the source of truth — this
    function only renders it for HF discoverability.
    """
    runtime = manifest.get("runtime", {})
    args = runtime.get("args", [])
    # Group flag/value pairs on the same line for a tidy bash invocation.
    pairs: list[str] = []
    i = 0
    while i < len(args):
        arg = str(args[i])
        if arg.startswith("--") and i + 1 < len(args) and not str(args[i + 1]).startswith("--"):
            pairs.append(f"{arg} {args[i + 1]}")
            i += 2
        else:
            pairs.append(arg)
            i += 1
    cmd = (
        str(runtime.get("binary", "llama-server"))
        + (" \\\n  " + " \\\n  ".join(pairs) if pairs else "")
    )
    gguf = manifest.get("gguf", {})
    types = gguf.get("ggml_types", {})

    applied_rows = []
    for name, block in (manifest.get("applied") or {}).items():
        applied = block.get("applied", False)
        sidecar = block.get("sidecar", "—")
        skip_reason = block.get("reason", "")
        marker = "yes" if applied else f"skipped — {skip_reason}"
        applied_rows.append(f"| `{name}` | {marker} | {sidecar} |")
    applied_table = "\n".join(applied_rows) if applied_rows else "| — | — | — |"

    return (
        "---\n"
        "library_name: llama.cpp\n"
        "tags:\n"
        "  - milady\n"
        "  - milady-optimized\n"
        "  - gguf\n"
        "  - polarquant\n"
        "  - qjl\n"
        "  - turboquant\n"
        "  - dflash\n"
        "---\n"
        "\n"
        "# Milady-optimized GGUF\n"
        "\n"
        f"Base model: `{manifest.get('base_model')}`  \n"
        f"Repo: `{config.repo_id}`  \n"
        f"GGUF tensor file: `{gguf.get('filename')}`  \n"
        "\n"
        "## Applied optimizations\n"
        "\n"
        "| step | applied | sidecar |\n"
        "|---|---|---|\n"
        + applied_table
        + "\n\n"
        "## GGML types in this file\n"
        "\n"
        f"- Weights: `{types.get('weights', 'Q4_POLAR=47')}` (PolarQuant 4-bit)\n"
        f"- K cache: `{types.get('k_cache', 'QJL1_256=46')}` (QJL 1-bit JL projection)\n"
        f"- V cache: `{types.get('v_cache', 'TBQ3_0=43')}` (TurboQuant 3-bit)\n"
        "\n"
        "These types only exist in `milady-ai/llama.cpp` "
        f"`>= {runtime.get('min_llama_cpp_tag', 'v0.4.0-milady')}` "
        f"(commit `{runtime.get('min_llama_cpp_commit', '')}`); the upstream "
        "`ggml-org/llama.cpp` build will refuse to load this file.\n"
        "\n"
        "## Load command\n"
        "\n"
        "```bash\n"
        f"{cmd}\n"
        "```\n"
    )


def build_model_card(
    config: PushConfig,
    training_args: dict[str, Any],
    bench: dict[str, Any],
) -> str:
    """Construct an HF model card for the eliza-1 release.

    Resolution order:
      1. If a ``--milady-manifest`` was passed, render directly from the
         manifest (canonical Milady-optimized release path).
      2. If the checkpoint dir already contains a README.md, ship it verbatim
         (downstream tools — e.g. abliterate.py — can author a richer card
         than this template covers).
      3. Otherwise render the template under scripts/templates/ that matches
         this push's variant + quant flavor.

    The legacy ``bench`` arg is folded into ``config.eval_results`` if the
    latter is empty, for backwards compatibility with checkpoints that wrote
    a benchmark.json sidecar.
    """
    if config.milady_manifest is not None:
        try:
            manifest = json.loads(config.milady_manifest.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise SystemExit(
                f"--milady-manifest is unreadable: {config.milady_manifest}: {exc}"
            ) from exc
        log.info("rendering model card from milady manifest %s",
                 config.milady_manifest)
        return _build_milady_manifest_card(config, manifest)

    checkpoint_readme = config.checkpoint / "README.md"
    if checkpoint_readme.exists():
        log.info("using checkpoint-bundled README.md (%s)", checkpoint_readme)
        return checkpoint_readme.read_text()

    if not config.eval_results and bench:
        # Adopt the legacy benchmark.json sidecar as the eval results
        # source if --eval-results wasn't passed explicitly.
        config = PushConfig(
            **{**config.__dict__, "eval_results": bench},
        )

    template_path = _select_template_path(config)
    if not template_path.exists():
        raise SystemExit(
            f"model card template not found: {template_path}. "
            "scripts/templates/ should ship with the repo — re-clone or "
            "restore the file."
        )

    template_text = template_path.read_text()
    ctx = _build_template_context(config, training_args)
    try:
        return template_text.format(**ctx)
    except KeyError as exc:
        raise SystemExit(
            f"template {template_path.name} references undefined placeholder "
            f"{exc!s}; available keys: {sorted(ctx)}"
        ) from exc


# ---------------------------------------------------------------------------
# Push
# ---------------------------------------------------------------------------


def preflight(config: PushConfig) -> tuple[bool, list[str]]:
    """Best-effort sanity checks before talking to HF."""
    issues: list[str] = []
    if not config.checkpoint.exists():
        issues.append(f"checkpoint path does not exist: {config.checkpoint}")
    elif not config.checkpoint.is_dir():
        issues.append(f"checkpoint path is not a directory: {config.checkpoint}")
    elif not any(config.checkpoint.iterdir()):
        issues.append(f"checkpoint directory is empty: {config.checkpoint}")
    if not hf_token() and not config.dry_run:
        issues.append("HF_TOKEN (or HUGGINGFACE_HUB_TOKEN) env var not set.")
    if config.quant and config.quant.startswith("gguf") and config.checkpoint.exists():
        if not list(config.checkpoint.glob("*.gguf")):
            issues.append(
                f"--quant {config.quant} was passed but no *.gguf files in {config.checkpoint}"
            )
    # Abliterated weights are only safe to publish when the script that
    # produced them wrote the metadata sidecar with the eval gates' output.
    # Refuse to push without it — accidental upload of an unverified
    # uncensored checkpoint is the failure mode this guard exists for.
    if config.variant == "abliterated" and config.checkpoint.exists():
        if not (config.checkpoint / "abliteration_metadata.json").exists():
            issues.append(
                "--variant abliterated requires abliteration_metadata.json in "
                f"{config.checkpoint} (produced by scripts/training/abliterate.py)"
            )
    return (len(issues) == 0, issues)


def push(config: PushConfig) -> int:
    ok, issues = preflight(config)
    for issue in issues:
        log.error("preflight: %s", issue)
    if not ok and not config.dry_run:
        return 1

    log.info("registry_key=%s", config.registry_key)
    log.info("checkpoint=%s", config.checkpoint)
    log.info("repo_id=%s (quant=%s)", config.repo_id, config.quant or "—")
    log.info("dry_run=%s, public=%s, readme_only=%s",
             config.dry_run, config.public, config.readme_only)

    training_args = read_optional_json(config.checkpoint / "training_args.json")
    bench = read_optional_json(config.checkpoint / "benchmark.json")
    card = build_model_card(config, training_args, bench)

    if config.dry_run:
        log.info("dry-run: model card preview\n%s", card)
        return 0

    from huggingface_hub import HfApi
    from huggingface_hub.errors import RepositoryNotFoundError

    api = HfApi(token=hf_token())

    try:
        api.repo_info(config.repo_id, repo_type="model")
        log.info("repo %s already exists", config.repo_id)
    except RepositoryNotFoundError:
        log.info("repo %s does not exist — creating (private=%s)",
                 config.repo_id, not config.public)
        api.create_repo(
            repo_id=config.repo_id,
            repo_type="model",
            private=not config.public,
            exist_ok=False,
        )

    # Always upload the model card (kept in sync with training metadata).
    api.upload_file(
        path_or_fileobj=card.encode("utf-8"),
        path_in_repo="README.md",
        repo_id=config.repo_id,
        repo_type="model",
        commit_message=f"eliza-1: refresh model card ({config.quant or 'bf16'})",
    )
    if config.readme_only:
        log.info("README-only mode — skipping weights upload.")
        return 0

    # Decide between upload_folder and upload_large_folder based on size.
    # 50 GB is HfApi's recommended cutover.
    total_bytes = sum(
        f.stat().st_size for f in config.checkpoint.rglob("*") if f.is_file()
    )
    log.info("uploading %d files, %.1f GB", sum(1 for _ in config.checkpoint.rglob("*") if _.is_file()), total_bytes / 1e9)

    if total_bytes > 50 * 1024**3:
        log.info("payload >50 GB, using upload_large_folder")
        api.upload_large_folder(
            folder_path=str(config.checkpoint),
            repo_id=config.repo_id,
            repo_type="model",
        )
    else:
        api.upload_folder(
            folder_path=str(config.checkpoint),
            repo_id=config.repo_id,
            repo_type="model",
            commit_message=f"eliza-1: upload {config.quant or 'bf16'} checkpoint",
            ignore_patterns=["*.tmp", "*.lock", "training_state*", "optimizer.pt"],
        )

    log.info("done. https://huggingface.co/%s", config.repo_id)
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument(
        "--registry-key", required=True,
        help=f"One of: {sorted(REGISTRY.keys())}",
    )
    ap.add_argument(
        "--checkpoint", type=Path, required=True,
        help="Path to the trained checkpoint folder (or quantized sidecar).",
    )
    ap.add_argument(
        "--repo-id", default=None,
        help="Override destination repo. Default: registry's eliza_repo_id "
             "(+ -<quant> suffix when --quant is set).",
    )
    ap.add_argument(
        "--quant", default=None,
        choices=sorted(QUANT_BLURBS.keys()),
        help="Quantization variant. Triggers a sibling repo + tweaks the "
             "model card.",
    )
    ap.add_argument(
        "--variant", default="default", choices=("default", "abliterated"),
        help="Release lineage. 'abliterated' targets entry.abliteration_repo_id "
             "and requires abliteration_metadata.json in the checkpoint dir.",
    )
    ap.add_argument("--public", action="store_true",
                    help="Create the repo as public (default: private).")
    ap.add_argument("--readme-only", action="store_true",
                    help="Refresh the model card without re-uploading weights.")
    ap.add_argument(
        "--eval-results", type=Path, default=None,
        help="Path to a JSON file with benchmark scores "
             "({\"mmlu\": 0.62, \"gsm8k\": 0.71, ...}). Rendered into the "
             "Evaluation section of the model card. Without it the section "
             "shows a TBD placeholder.",
    )
    ap.add_argument(
        "--milady-manifest", type=Path, default=None,
        help="Path to a milady_manifest.json from optimize_for_milady.py. "
             "Triggers manifest-driven model card rendering and supersedes "
             "the per-quant template. Use for milady-ai/* repo publishes.",
    )
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the resolved config + card preview, no network calls.")
    args = ap.parse_args()

    eval_results: dict[str, Any] = {}
    if args.eval_results is not None:
        if not args.eval_results.exists():
            raise SystemExit(f"--eval-results path does not exist: {args.eval_results}")
        try:
            eval_results = json.loads(args.eval_results.read_text())
        except json.JSONDecodeError as exc:
            raise SystemExit(f"--eval-results is not valid JSON: {exc}") from exc

    if args.milady_manifest is not None and not args.milady_manifest.exists():
        raise SystemExit(
            f"--milady-manifest does not exist: {args.milady_manifest}"
        )

    config = PushConfig(
        registry_key=args.registry_key,
        checkpoint=args.checkpoint,
        repo_id=resolve_repo_id(
            args.registry_key, args.quant, args.variant, args.repo_id,
        ),
        quant=args.quant,
        variant=args.variant,
        public=args.public,
        readme_only=args.readme_only,
        dry_run=args.dry_run,
        eval_results=eval_results,
        milady_manifest=args.milady_manifest,
    )
    return push(config)


if __name__ == "__main__":
    sys.exit(main())
