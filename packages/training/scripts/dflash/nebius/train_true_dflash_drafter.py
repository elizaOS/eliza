#!/usr/bin/env python3
"""Train and export a true DFlash-head drafter on Nebius H200.

This is intentionally separate from ``distill_drafter_h200.py``. That script
trains a plain autoregressive ``AutoModelForCausalLM`` draft model; this one
trains the upstream DFlash architecture whose GGUF is loaded by the local
``dflash-draft`` runtime:

  target hidden states -> fc + hidden_norm -> 5 DFlash decoder blocks

The produced GGUF has ``general.architecture=dflash-draft`` and the
``dflash-draft.dflash.*`` metadata required by llama.cpp.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import logging
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

_TRAINING_ROOT = Path(__file__).resolve().parents[3]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.distill_dflash_drafter import (  # noqa: E402
    GGUF_TARGET_CHECKPOINT_KEY,
    _sha256_file,
    _tokenizer_parity_report,
)

log = logging.getLogger("train_true_dflash_drafter")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

DEFAULT_TARGET_LAYERS: dict[str, list[int]] = {
    "0_8b": [0, 2, 4, 6, 7],
    "2b": [1, 5, 9, 13, 15],
    "4b": [1, 8, 15, 22, 29],
}

TENSOR_MAP = {
    "fc.weight": "dflash_fc.weight",
    "hidden_norm.weight": "dflash_hidden_norm.weight",
    "norm.weight": "output_norm.weight",
}


def _git_commit() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=_TRAINING_ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except Exception:
        return None


def _load_module(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location("dflash_impl", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load DFlash implementation: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["dflash_impl"] = module
    spec.loader.exec_module(module)
    return module


def _resolve_dflash_impl(path_or_repo: str) -> Path:
    candidate = Path(path_or_repo)
    if candidate.exists():
        return candidate
    try:
        from huggingface_hub import hf_hub_download  # noqa: PLC0415
    except ImportError as exc:
        raise SystemExit(
            "--dflash-impl is not a file and huggingface_hub is unavailable"
        ) from exc
    return Path(hf_hub_download(path_or_repo, "dflash.py"))


def _target_text_config(config: Any) -> Any:
    return getattr(config, "text_config", config)


def _dflash_config_from_target(args: argparse.Namespace, target_config: Any) -> Any:
    from transformers import Qwen3Config  # noqa: PLC0415

    text = _target_text_config(target_config)
    target_layers = (
        [int(x) for x in args.target_layer_ids.split(",")]
        if args.target_layer_ids
        else DEFAULT_TARGET_LAYERS[args.target_tier]
    )
    hidden_size = int(getattr(text, "hidden_size"))
    head_dim = int(getattr(text, "head_dim", hidden_size // int(getattr(text, "num_attention_heads"))))
    n_heads = max(1, hidden_size // head_dim)
    n_kv = min(max(1, int(getattr(text, "num_key_value_heads", max(1, n_heads // 4)))), n_heads)
    cfg = Qwen3Config(
        vocab_size=int(getattr(text, "vocab_size")),
        hidden_size=hidden_size,
        intermediate_size=int(args.intermediate_size or getattr(text, "intermediate_size")),
        num_hidden_layers=int(args.num_hidden_layers),
        num_attention_heads=n_heads,
        num_key_value_heads=n_kv,
        head_dim=head_dim,
        hidden_act=str(getattr(text, "hidden_act", "silu")),
        rms_norm_eps=float(getattr(text, "rms_norm_eps", 1e-6)),
        rope_theta=float(getattr(text, "rope_theta", 10_000_000.0)),
        max_position_embeddings=int(getattr(text, "max_position_embeddings", 262144)),
        tie_word_embeddings=True,
        attention_bias=False,
        attention_dropout=0.0,
        use_cache=True,
    )
    cfg.architectures = ["DFlashDraftModel"]
    cfg.auto_map = {"AutoModel": "dflash.DFlashDraftModel"}
    cfg.block_size = int(args.block_size)
    cfg.dflash_config = {
        "mask_token_id": int(args.mask_token_id),
        "target_layer_ids": target_layers,
    }
    cfg.num_target_layers = int(getattr(text, "num_hidden_layers"))
    cfg.layer_types = ["full_attention"] * int(args.num_hidden_layers)
    return cfg


def _render_batch(tokenizer: Any, items: list[str]) -> list[str]:
    rendered = []
    for item in items:
        text = item
        if item.startswith("["):
            try:
                messages = json.loads(item)
            except json.JSONDecodeError:
                messages = None
            if isinstance(messages, list) and hasattr(tokenizer, "apply_chat_template"):
                text = tokenizer.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=False
                )
        rendered.append(text)
    return rendered


def _read_jsonl(path: Path, max_samples: int) -> list[str]:
    rows: list[str] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if max_samples and len(rows) >= max_samples:
                break
            raw = line.strip()
            if not raw:
                continue
            try:
                item = json.loads(raw)
                if isinstance(item, str):
                    rows.append(item)
                elif isinstance(item, dict):
                    rows.append(
                        item.get("text")
                        or item.get("prompt")
                        or json.dumps(item.get("messages") or item)
                    )
            except json.JSONDecodeError:
                rows.append(raw)
    if not rows:
        raise SystemExit(f"no training examples found in {path}")
    return rows


def train(args: argparse.Namespace) -> dict[str, Any]:
    import torch  # noqa: PLC0415
    import torch.nn.functional as F  # noqa: PLC0415
    from torch.utils.data import DataLoader  # noqa: PLC0415
    from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer  # noqa: PLC0415

    if not args.synthetic_smoke and not torch.cuda.is_available():
        raise SystemExit("real true-DFlash training requires CUDA/H200; use --synthetic-smoke locally")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32

    target_config = AutoConfig.from_pretrained(args.target_checkpoint, trust_remote_code=True)
    dflash_config = _dflash_config_from_target(args, target_config)
    impl = _load_module(_resolve_dflash_impl(args.dflash_impl))
    drafter = impl.DFlashDraftModel(dflash_config).to(device=device, dtype=dtype)
    drafter.train()

    target = AutoModelForCausalLM.from_pretrained(
        args.target_checkpoint,
        torch_dtype=dtype,
        trust_remote_code=True,
        output_hidden_states=True,
    ).to(device)
    target.eval()

    tokenizer = AutoTokenizer.from_pretrained(args.target_checkpoint, trust_remote_code=True)
    parity = _tokenizer_parity_report(tokenizer, tokenizer)
    examples = ["hello world"] * max(args.batch_size, 2) if args.synthetic_smoke else _read_jsonl(Path(args.dataset_path), args.max_samples)

    try:
        from apollo_torch import APOLLOAdamW as APOLLO  # noqa: PLC0415
        optimizer = APOLLO(drafter.parameters(), lr=args.lr)
    except Exception:
        if not args.synthetic_smoke:
            raise
        optimizer = torch.optim.AdamW(drafter.parameters(), lr=args.lr)

    output_head = target.get_output_embeddings()
    input_emb = target.get_input_embeddings()
    target_layer_ids = list(dflash_config.dflash_config["target_layer_ids"])

    def collate(batch: list[str]) -> dict[str, Any]:
        enc = tokenizer(
            _render_batch(tokenizer, batch),
            return_tensors="pt",
            padding="max_length",
            truncation=True,
            max_length=args.max_seq_len,
        )
        return {k: v.to(device) for k, v in enc.items()}

    loader = DataLoader(examples, batch_size=args.batch_size, shuffle=True, drop_last=True, collate_fn=collate)
    step = 0
    final_loss = None
    optimizer.zero_grad()
    for epoch in range(args.epochs):
        for batch in loader:
            if args.max_steps and step >= args.max_steps:
                break
            input_ids = batch["input_ids"]
            attn = batch["attention_mask"]
            with torch.no_grad():
                target_out = target(input_ids=input_ids, attention_mask=attn, output_hidden_states=True)
                teacher_logits = target_out.logits[:, :-1, :]
                selected = [target_out.hidden_states[i + 1][:, :-1, :] for i in target_layer_ids]
                target_hidden = torch.cat(selected, dim=-1)
                noise_embedding = input_emb(input_ids[:, :-1])

            seq = input_ids.size(1) - 1
            position_ids = torch.arange(seq + seq, device=device).unsqueeze(0).expand(input_ids.size(0), -1)
            # The DFlash attention sees target context + draft positions. Keep
            # the initial trainer simple and dense; runtime benchmarking decides
            # whether this candidate is worth longer distillation.
            attn_mask = torch.zeros((input_ids.size(0), 1, seq, seq + seq), device=device, dtype=dtype)
            hidden = drafter(
                position_ids=position_ids,
                attention_mask=attn_mask,
                noise_embedding=noise_embedding,
                target_hidden=target_hidden,
            )
            logits = output_head(hidden)
            labels = input_ids[:, 1:]
            mask = attn[:, 1:].bool()
            topk = torch.topk(teacher_logits, k=min(args.top_k_logits, teacher_logits.size(-1)), dim=-1)
            student_topk = torch.gather(logits, -1, topk.indices)
            kl = F.kl_div(
                F.log_softmax(student_topk / args.temperature, dim=-1),
                F.log_softmax(topk.values / args.temperature, dim=-1),
                reduction="none",
                log_target=True,
            ).sum(-1)
            kl = (kl * mask).sum() / mask.sum().clamp_min(1)
            ce = F.cross_entropy(logits.reshape(-1, logits.size(-1)), labels.reshape(-1), reduction="none").reshape(labels.shape)
            ce = (ce * mask).sum() / mask.sum().clamp_min(1)
            loss = ((1 - args.ce_weight) * (args.temperature**2) * kl + args.ce_weight * ce) / args.grad_accum
            loss.backward()
            if (step + 1) % args.grad_accum == 0:
                torch.nn.utils.clip_grad_norm_(drafter.parameters(), 1.0)
                optimizer.step()
                optimizer.zero_grad()
            final_loss = float((loss * args.grad_accum).detach().cpu())
            if step % args.log_every == 0:
                log.info("epoch=%d step=%d loss=%.4f kl=%.4f ce=%.4f", epoch, step, final_loss, float(kl.detach().cpu()), float(ce.detach().cpu()))
            step += 1
        if args.max_steps and step >= args.max_steps:
            break

    out = Path(args.output_dir)
    ckpt = out / "checkpoint-final"
    ckpt.mkdir(parents=True, exist_ok=True)
    drafter.save_pretrained(ckpt)
    tokenizer.save_pretrained(ckpt)
    dflash_config.save_pretrained(ckpt)
    return {
        "checkpoint": str(ckpt),
        "steps": step,
        "finalLoss": final_loss,
        "tokenizerParity": parity,
        "targetLayerIds": target_layer_ids,
        "hiddenSize": int(dflash_config.hidden_size),
    }


def _map_tensor_name(name: str) -> str | None:
    if name in TENSOR_MAP:
        return TENSOR_MAP[name]
    if name.startswith("layers."):
        parts = name.split(".")
        if len(parts) < 4:
            return None
        layer = parts[1]
        tail = ".".join(parts[2:])
        repl = {
            "input_layernorm.weight": f"blk.{layer}.attn_norm.weight",
            "post_attention_layernorm.weight": f"blk.{layer}.post_attention_norm.weight",
            "self_attn.q_proj.weight": f"blk.{layer}.attn_q.weight",
            "self_attn.k_proj.weight": f"blk.{layer}.attn_k.weight",
            "self_attn.v_proj.weight": f"blk.{layer}.attn_v.weight",
            "self_attn.o_proj.weight": f"blk.{layer}.attn_output.weight",
            "self_attn.q_norm.weight": f"blk.{layer}.attn_q_norm.weight",
            "self_attn.k_norm.weight": f"blk.{layer}.attn_k_norm.weight",
            "mlp.gate_proj.weight": f"blk.{layer}.ffn_gate.weight",
            "mlp.down_proj.weight": f"blk.{layer}.ffn_down.weight",
            "mlp.up_proj.weight": f"blk.{layer}.ffn_up.weight",
        }
        return repl.get(tail)
    return None


def export_gguf(args: argparse.Namespace, checkpoint: Path) -> Path:
    import torch  # noqa: PLC0415
    import gguf  # type: ignore  # noqa: PLC0415
    from gguf.scripts.gguf_new_metadata import MetadataDetails  # type: ignore  # noqa: PLC0415
    from transformers import AutoConfig  # noqa: PLC0415

    cfg = AutoConfig.from_pretrained(checkpoint, trust_remote_code=True)
    out = Path(args.output_dir) / f"drafter-{args.target_tier}.gguf"
    out.parent.mkdir(parents=True, exist_ok=True)
    writer = gguf.GGUFWriter(str(out), "dflash-draft")

    if args.target_gguf:
        reader = gguf.GGUFReader(str(args.target_gguf), "r")
        for field in reader.fields.values():
            if field.name.startswith("tokenizer.ggml."):
                val_type = field.types[0]
                sub_type = field.types[-1] if val_type == gguf.GGUFValueType.ARRAY else None
                writer.add_key_value(field.name, field.contents(), val_type, sub_type=sub_type)

    writer.add_name(f"eliza-1-{args.target_tier}-dflash-draft")
    writer.add_block_count(int(cfg.num_hidden_layers))
    writer.add_context_length(int(cfg.max_position_embeddings))
    writer.add_embedding_length(int(cfg.hidden_size))
    writer.add_feed_forward_length(int(cfg.intermediate_size))
    writer.add_head_count(int(cfg.num_attention_heads))
    writer.add_head_count_kv(int(cfg.num_key_value_heads))
    writer.add_key_length(int(cfg.head_dim))
    writer.add_value_length(int(cfg.head_dim))
    writer.add_rope_dimension_count(int(cfg.head_dim))
    writer.add_rope_freq_base(float(getattr(cfg, "rope_theta", 10_000_000.0)))
    writer.add_layer_norm_rms_eps(float(cfg.rms_norm_eps))
    writer.add_causal_attention(False)
    writer.add_uint32("dflash-draft.dflash.block_size", int(cfg.block_size))
    writer.add_uint32("dflash-draft.dflash.mask_token_id", int(cfg.dflash_config["mask_token_id"]))
    writer.add_array("dflash-draft.dflash.target_layer_ids", [int(x) for x in cfg.dflash_config["target_layer_ids"]])
    writer.add_uint32("dflash-draft.dflash.n_target_features", int(cfg.hidden_size) * len(cfg.dflash_config["target_layer_ids"]))
    if args.target_gguf:
        writer.add_key_value(
            GGUF_TARGET_CHECKPOINT_KEY,
            _sha256_file(Path(args.target_gguf)),
            gguf.GGUFValueType.STRING,
        )

    state_path = checkpoint / "model.safetensors"
    if state_path.exists():
        from safetensors.torch import load_file  # noqa: PLC0415
        state = load_file(str(state_path), device="cpu")
    else:
        state = torch.load(checkpoint / "pytorch_model.bin", map_location="cpu")

    written = 0
    for name, tensor in state.items():
        mapped = _map_tensor_name(name)
        if mapped is None:
            continue
        arr = tensor.detach().float().cpu().numpy()
        writer.add_tensor(mapped, np.ascontiguousarray(arr))
        written += 1
    if written == 0:
        raise SystemExit(f"no DFlash tensors exported from {checkpoint}")
    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    log.info("wrote %s (%d tensors)", out, written)
    return out


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--target-tier", required=True, choices=["0_8b", "2b", "4b"])
    p.add_argument("--target-checkpoint", required=True)
    p.add_argument("--target-gguf")
    p.add_argument("--dataset-path", required=True)
    p.add_argument("--output-dir", required=True)
    p.add_argument("--dflash-impl", default="z-lab/Qwen3.5-4B-DFlash")
    p.add_argument("--target-layer-ids", default="")
    p.add_argument("--num-hidden-layers", type=int, default=5)
    p.add_argument("--intermediate-size", type=int, default=0)
    p.add_argument("--block-size", type=int, default=16)
    p.add_argument("--mask-token-id", type=int, default=248070)
    p.add_argument("--epochs", type=int, default=1)
    p.add_argument("--batch-size", type=int, default=1)
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--max-steps", type=int, default=1000)
    p.add_argument("--max-samples", type=int, default=0)
    p.add_argument("--max-seq-len", type=int, default=512)
    p.add_argument("--temperature", type=float, default=1.0)
    p.add_argument("--ce-weight", type=float, default=0.1)
    p.add_argument("--top-k-logits", type=int, default=64)
    p.add_argument("--log-every", type=int, default=10)
    p.add_argument("--skip-export", action="store_true")
    p.add_argument("--export-only", type=Path)
    p.add_argument("--synthetic-smoke", action="store_true")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    started = datetime.now(timezone.utc)
    if args.export_only:
        gguf_path = export_gguf(args, args.export_only)
        result = {"checkpoint": str(args.export_only), "gguf": str(gguf_path)}
    else:
        result = train(args)
        if not args.skip_export:
            result["gguf"] = str(export_gguf(args, Path(result["checkpoint"])))
    result.update(
        {
            "kind": "true-dflash-drafter-training",
            "targetTier": args.target_tier,
            "targetCheckpoint": args.target_checkpoint,
            "targetGguf": args.target_gguf,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "elapsedSeconds": (datetime.now(timezone.utc) - started).total_seconds(),
            "trainingCommit": _git_commit(),
            "synthetic": bool(args.synthetic_smoke),
        }
    )
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    manifest = out / f"drafter-{args.target_tier}.true-dflash.json"
    manifest.write_text(json.dumps(result, indent=2) + "\n")
    log.info("wrote %s", manifest)


if __name__ == "__main__":
    main()
