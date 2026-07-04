"""Shared loaders and IO helpers for the quantization apply scripts.

The four CLI entry points in this directory (``polarquant_apply``,
``turboquant_apply``, ``fused_turboquant_apply``, ``qjl_apply``) all need
the same handful of building blocks: detect a LoRA adapter directory,
resolve its base, load model+tokenizer, save them, and write a JSON
sidecar. This module is the single source of truth for that surface.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
from pathlib import Path
from typing import TYPE_CHECKING, Mapping

import torch
import torch.nn as nn

if TYPE_CHECKING:
    # Static-only import. ``PretrainedConfig`` is the upstream type for
    # every HF causal-LM config (``model.config``); importing it eagerly
    # would force transformers at import time even for tests that just
    # want the helpers below. Behind ``TYPE_CHECKING`` mypy/pyright still
    # see the strong type and reject helpers that misuse the config.
    from transformers import PretrainedConfig
    from transformers.tokenization_utils_base import PreTrainedTokenizerBase

log = logging.getLogger(__name__)


REPO_ROOT = Path(__file__).resolve().parents[4]
LLAMA_CPP_RELATIVE_DIR = Path("plugins/plugin-local-inference/native/llama.cpp")
DEFAULT_LLAMA_CPP_DIR = REPO_ROOT / LLAMA_CPP_RELATIVE_DIR


def llama_cpp_vendor_hint() -> str:
    """Actionable setup text for callers that need the in-repo llama.cpp fork."""
    rel = LLAMA_CPP_RELATIVE_DIR.as_posix()
    return (
        "The llama.cpp fork submodule should already be checked out. If it's "
        "missing:\n"
        f"  git submodule update --init {rel}\n"
        "Then build the llama-quantize + llama-cli binaries from it "
        "(one-shot, CPU-only is enough):\n"
        f"  cmake -S {rel} -B {rel}/build \\\n"
        "        -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF "
        "-DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF\n"
        f"  cmake --build {rel}/build --target llama-quantize llama-cli "
        '-j"$(nproc)"\n'
        "Or pass --llama-cpp-dir <path-to-checkout> / set LLAMA_CPP_DIR / "
        "put the binaries on PATH.\n"
        "(convert_hf_to_gguf.py needs the `gguf` + `mistral_common` python "
        f"deps; `uv pip install -r {rel}/requirements/"
        "requirements-convert_hf_to_gguf.txt`.)"
    )


def _llama_cpp_dirs(llama_cpp_dir: Path | None) -> list[Path]:
    """Candidate llama.cpp checkout roots in release-safe resolution order."""
    candidates: list[Path] = []
    if llama_cpp_dir is not None:
        candidates.append(llama_cpp_dir)
    env_dir = os.environ.get("LLAMA_CPP_DIR")
    if env_dir:
        candidates.append(Path(env_dir))
    candidates.append(DEFAULT_LLAMA_CPP_DIR)
    return candidates


def find_llama_convert_script(llama_cpp_dir: Path | None) -> Path:
    """Locate ``convert_hf_to_gguf.py`` from the canonical fork or PATH."""
    candidates = [d / "convert_hf_to_gguf.py" for d in _llama_cpp_dirs(llama_cpp_dir)]
    which = shutil.which("convert_hf_to_gguf.py")
    if which:
        candidates.append(Path(which))
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise SystemExit("convert_hf_to_gguf.py not found.\n" + llama_cpp_vendor_hint())


def find_llama_quantize_binary(llama_cpp_dir: Path | None) -> Path:
    """Locate ``llama-quantize`` from the canonical fork build or PATH."""
    candidates: list[Path] = []
    for directory in _llama_cpp_dirs(llama_cpp_dir):
        candidates.extend(
            [
                directory / "build" / "bin" / "llama-quantize",
                directory / "llama-quantize",
            ]
        )
    which = shutil.which("llama-quantize")
    if which:
        candidates.append(Path(which))
    for candidate in candidates:
        if candidate.exists() and os.access(candidate, os.X_OK):
            return candidate
    raise SystemExit("llama-quantize binary not found.\n" + llama_cpp_vendor_hint())


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
    from transformers import AutoModelForCausalLM, AutoTokenizer

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
    model: nn.Module, tokenizer: "PreTrainedTokenizerBase", output_dir: Path
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
    KERNEL_CODEBOOK_HASH_SOURCES,
    KERNEL_CODEBOOK_HASHES,
    KERNEL_PER_BLOCK_TOLERANCE,
    KERNEL_RECIPE_TARGET_CLASSES,
    KERNEL_TARGETS,
    PINNED_KERNEL_CODEBOOK_SHA256,
    kernel_manifest_fragment,
    verify_kernel_codebook_hashes,
)


def get_text_config(model_config: "PretrainedConfig") -> "PretrainedConfig":
    """Return the text-decoder sub-config for hybrid VLM/decoder models, else
    ``model_config`` itself.
    """
    getter = getattr(model_config, "get_text_config", None)
    if callable(getter):
        return getter(decoder=True)
    return model_config


def head_dim_of(text_cfg: "PretrainedConfig") -> int:
    """Resolve head_dim from a text decoder config, falling back to
    ``hidden_size // num_attention_heads`` when ``head_dim`` isn't set.
    """
    explicit = getattr(text_cfg, "head_dim", None)
    if explicit:
        return int(explicit)
    # ``hidden_size`` and ``num_attention_heads`` are required fields on
    # any decoder config; fall through with a clear assertion so a wrong
    # config type fails fast instead of raising AttributeError downstream.
    assert hasattr(text_cfg, "hidden_size") and hasattr(
        text_cfg, "num_attention_heads"
    ), (
        "head_dim_of requires a transformers PretrainedConfig with "
        "hidden_size + num_attention_heads"
    )
    return int(text_cfg.hidden_size // text_cfg.num_attention_heads)


def full_attention_layer_indices(text_cfg: "PretrainedConfig") -> list[int]:
    """Indices of ``full_attention`` layers on hybrid decoder configs, or
    ``range(num_hidden_layers)`` when ``layer_types`` is absent.
    """
    layer_types = getattr(text_cfg, "layer_types", None)
    if layer_types:
        return [i for i, t in enumerate(layer_types) if t == "full_attention"]
    assert hasattr(text_cfg, "num_hidden_layers"), (
        "full_attention_layer_indices requires a PretrainedConfig with "
        "num_hidden_layers"
    )
    return list(range(int(text_cfg.num_hidden_layers)))


def add_quantization_cli_args(parser: argparse.ArgumentParser) -> None:
    """Add the CLI flags shared by every ``*_apply.py`` recipe.

    The shared surface (``--model``, ``--output``, ``--calibration``,
    ``--calibration-samples``, ``--device``, ``--dry-run``) is identical
    across turboquant, fused-turboquant, polarquant, qjl, and
    abliteration. Recipe-specific flags (``--nbits``, ``--bits``,
    ``--no-compress-v``, …) stay in each script so the help text in
    ``--help`` accurately reflects which knobs that recipe accepts.
    """
    parser.add_argument(
        "--model",
        required=True,
        help=(
            "HF repo id or local path. LoRA adapter dirs are merged "
            "automatically."
        ),
    )
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--calibration",
        type=Path,
        default=None,
        help=(
            "Optional JSONL of records with currentMessage.content for "
            "calibration. Recipes that don't read it (fused-turboquant) "
            "still validate the file exists when the flag is present."
        ),
    )
    parser.add_argument("--calibration-samples", type=int, default=128)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--dry-run", action="store_true")


def validate_quantization_args(args: argparse.Namespace) -> None:
    """Cross-cut validation for the shared CLI args.

    Currently:
    - ``--calibration PATH`` (when set) must point at an existing file.
    - ``--device cuda`` requires CUDA on this host unless this is only a
      ``--dry-run`` CLI/recipe validation pass.
    """
    if args.calibration is not None and not args.calibration.exists():
        raise FileNotFoundError(
            f"--calibration path does not exist: {args.calibration}"
        )
    if (
        args.device == "cuda"
        and not getattr(args, "dry_run", False)
        and not torch.cuda.is_available()
    ):
        raise RuntimeError("CUDA requested but not available")


def load_calibration_prompts(path: Path, n: int) -> list[str]:
    """Pull up to n user-final prompts from a JSONL file.

    Supports both eliza_native_v1 format (request.messages array) and
    legacy format (currentMessage.content). Lines that fail JSON parse
    or carry no text are dropped silently. Raises RuntimeError if none survive.
    """
    out: list[str] = []
    with path.open("r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue
            rec = json.loads(line)
            text = ""
            # eliza_native_v1: find last user turn in request.messages
            req = rec.get("request") or {}
            msgs = req.get("messages") or []
            for msg in reversed(msgs):
                if msg.get("role") == "user":
                    c = msg.get("content") or ""
                    if isinstance(c, list):
                        c = " ".join(
                            p.get("text", "") for p in c
                            if isinstance(p, dict) and p.get("type") == "text"
                        )
                    text = c
                    break
            # legacy schema fallback
            if not text:
                text = (rec.get("currentMessage") or {}).get("content") or ""
            if text:
                out.append(text)
            if len(out) >= n:
                break
    if not out:
        raise RuntimeError(f"No prompts read from {path}")
    return out
