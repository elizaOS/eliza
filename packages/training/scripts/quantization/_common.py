"""Shared loaders and IO helpers for the quantization apply scripts.

The four CLI entry points in this directory (``polarquant_apply``,
``turboquant_apply``, ``fused_turboquant_apply``, ``qjl_apply``) all need
the same handful of building blocks: detect a LoRA adapter directory,
resolve its base, load model+tokenizer, save them, and write a JSON
sidecar. This module is the single source of truth for that surface.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Mapping

import torch
import torch.nn as nn
from transformers import AutoModelForCausalLM, AutoTokenizer
from transformers.tokenization_utils_base import PreTrainedTokenizerBase

log = logging.getLogger(__name__)


def is_lora_dir(path: Path) -> bool:
    """True iff ``path`` is a PEFT/LoRA adapter directory."""
    return (path / "adapter_config.json").exists()


def resolve_base_for_lora(adapter_dir: Path) -> str:
    """Return the base-model id recorded in a LoRA adapter's config.

    Raises ``RuntimeError`` if the field is missing.
    """
    cfg = json.loads((adapter_dir / "adapter_config.json").read_text(encoding="utf-8"))
    base = cfg.get("base_model_name_or_path")
    if not base:
        raise RuntimeError(
            f"adapter_config.json at {adapter_dir} has no base_model_name_or_path"
        )
    return base


def load_model_and_tokenizer(
    model_path: str,
    *,
    device_map: str = "cuda",
    dtype: torch.dtype = torch.bfloat16,
) -> tuple[nn.Module, PreTrainedTokenizerBase]:
    """Load a HF causal-LM checkpoint, merging a LoRA adapter if present."""
    p = Path(model_path)
    if p.exists() and is_lora_dir(p):
        base = resolve_base_for_lora(p)
        log.info("loading base %s + LoRA adapter %s", base, p)
        from peft import PeftModel

        tok = AutoTokenizer.from_pretrained(base, trust_remote_code=True)
        base_model = AutoModelForCausalLM.from_pretrained(
            base,
            torch_dtype=dtype,
            device_map=device_map,
            trust_remote_code=True,
        )
        merged = PeftModel.from_pretrained(base_model, str(p)).merge_and_unload()
        return merged, tok

    log.info("loading full model %s", model_path)
    tok = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        torch_dtype=dtype,
        device_map=device_map,
        trust_remote_code=True,
    )
    return model, tok


def save_model(
    model: nn.Module, tokenizer: PreTrainedTokenizerBase, output_dir: Path
) -> None:
    """Persist model + tokenizer to ``output_dir`` via safetensors."""
    output_dir.mkdir(parents=True, exist_ok=True)
    log.info("saving model to %s", output_dir)
    model.save_pretrained(str(output_dir), safe_serialization=True)
    tokenizer.save_pretrained(str(output_dir))


def write_sidecar(output_dir: Path, filename: str, payload: Mapping[str, object]) -> Path:
    """Write a sorted JSON sidecar next to the saved model. Returns its path."""
    out = output_dir / filename
    out.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return out


# Re-export from the zero-dep _kernel_manifest module so existing recipe
# imports (`from _common import kernel_manifest_fragment`) keep working
# while unit tests can import the helper without pulling in transformers.
from _kernel_manifest import (  # noqa: E402,F401
    KERNEL_BLOCK_LAYOUT_VERSIONS,
    KERNEL_CODEBOOK_HASHES,
    KERNEL_PER_BLOCK_TOLERANCE,
    KERNEL_TARGETS,
    kernel_manifest_fragment,
)


def get_text_config(model_config: object) -> object:
    """Return the text-decoder sub-config for hybrid VLM/decoder models, else
    ``model_config`` itself.
    """
    getter = getattr(model_config, "get_text_config", None)
    if callable(getter):
        return getter(decoder=True)
    return model_config


def head_dim_of(text_cfg: object) -> int:
    """Resolve head_dim from a text decoder config, falling back to
    ``hidden_size // num_attention_heads`` when ``head_dim`` isn't set.
    """
    explicit = getattr(text_cfg, "head_dim", None)
    if explicit:
        return int(explicit)
    return int(text_cfg.hidden_size // text_cfg.num_attention_heads)


def full_attention_layer_indices(text_cfg: object) -> list[int]:
    """Indices of ``full_attention`` layers (Qwen3.5/3.6 hybrid models),
    or ``range(num_hidden_layers)`` when ``layer_types`` is absent.
    """
    layer_types = getattr(text_cfg, "layer_types", None)
    if layer_types:
        return [i for i, t in enumerate(layer_types) if t == "full_attention"]
    return list(range(int(text_cfg.num_hidden_layers)))


def load_calibration_prompts(path: Path, n: int) -> list[str]:
    """Pull up to ``n`` user-final prompts from a val.jsonl shaped file.

    The eliza dataset schema stores the latest user turn under
    ``currentMessage.content``. Lines that fail JSON parse or carry no
    text are dropped silently. Raises ``RuntimeError`` if no prompts
    survive.
    """
    out: list[str] = []
    with path.open("r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue
            rec = json.loads(line)
            text = (rec.get("currentMessage") or {}).get("content") or ""
            if text:
                out.append(text)
            if len(out) >= n:
                break
    if not out:
        raise RuntimeError(f"No prompts read from {path}")
    return out
