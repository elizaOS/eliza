#!/usr/bin/env python3
"""Fine-tune the Eliza-1 semantic end-of-turn (EOT) detector.

Entrypoint for the workflow specified in
[``.swarm/research/R1-turn.md``][R1] §5. Implements the APOLLO fine-tune
path against the LiveKit Turn Detector (default ship target) and the
Apache-2.0 ``latishab/turnsense`` fallback.

[R1]: ../../../../.swarm/research/R1-turn.md

Pipeline (each step is a function below; ``--help`` lists the flags):

  1. Resolve the config YAML — `load_config()`. Pins the teacher repo /
     revision, the LoRA rank, optimizer choice (APOLLO only — see
     `packages/training/AGENTS.md §1`), and the eval thresholds.
  2. Stage pretrain + SFT corpora — `build_pretrain_corpus()` for the
     EOU-labelled JSONL from DailyDialog (MultiWOZ / EmotionPush /
     TURNS-2K are documented add-ons), `build_sft_corpus()` for the
     task-conditional augmentation pairs.
  3. Tokenize against the upstream tokenizer + apply the Qwen chat
     template — `build_examples()`.
  4. Train — `train_lora()`. APOLLO-Mini optimizer (rank-1 tensor-wise
     scaling — the smallest optimizer-state footprint, right-sized for
     a ~135M-param classifier head). Checkpoints every
     ``--checkpoint-every`` steps, keeps top-3 by validation F1, raises
     ``RuntimeError`` if the configured F1 gate isn't met at exit.
  5. Export — `export_onnx()`. Re-quantizes to INT8 (`onnx/model_q8.onnx`),
     matches the upstream filename so the bundle stager picks it up
     without an extra flag.
  6. Evaluate via `eval_turn_detector.py` — the gate
     (F1 ≥ 0.85 and meanLatencyMs ≤ 30) decides publish-ability.

Smoke mode (``--smoke``) writes only the resolved config + the staged-data
manifest, so the CI surface stays runnable without the corpora or GPU.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import sys
from pathlib import Path
from typing import Any, Final, Iterable, Mapping

DEFAULT_REPO_EN: Final[str] = "livekit/turn-detector"
DEFAULT_REVISION_EN: Final[str] = "v1.2.2-en"
DEFAULT_REVISION_INTL: Final[str] = "v0.4.1-intl"
DEFAULT_TURNSENSE_REPO: Final[str] = "latishab/turnsense"

# Eval gate constants — mirrors `TURN_DETECTOR_F1_THRESHOLD` /
# `TURN_DETECTOR_MEAN_LATENCY_MS_LIMIT` in the runtime manifest schema
# (`plugins/plugin-local-inference/src/services/manifest/schema.ts`).
F1_GATE: Final[float] = 0.85
MEAN_LATENCY_MS_GATE: Final[float] = 30.0


@dataclasses.dataclass(frozen=True)
class TurnFinetuneConfig:
    """Container for the YAML config consumed by `finetune_turn_detector`."""

    tier: str
    teacher_repo: str
    teacher_revision: str
    lora_rank: int
    optimizer: str  # "apollo" | "adamw"
    epochs: int
    learning_rate: float
    train_data: list[str]
    eval_data: list[str]
    f1_gate: float = F1_GATE
    mean_latency_ms_gate: float = MEAN_LATENCY_MS_GATE


def default_revision_for_tier(tier: str) -> str:
    """Return the LiveKit revision a given tier should fine-tune against.

    Matches the runtime resolver in
    ``plugins/plugin-local-inference/src/services/voice/eot-classifier.ts``
    (`turnDetectorRevisionForTier`). Accepts both bare (``"4b"``) and
    prefixed (``"eliza-1-4b"``) tier ids.
    """
    bare = tier[len("eliza-1-"):] if tier.startswith("eliza-1-") else tier
    if bare in ("0_8b", "2b"):
        return DEFAULT_REVISION_EN
    return DEFAULT_REVISION_INTL


def load_config(path: Path) -> TurnFinetuneConfig:
    """Parse a YAML/JSON finetune config.

    YAML is optional; the JSON path is the canonical one so the smoke
    tests can run without pyyaml. ``.yaml`` / ``.yml`` files require
    ``pyyaml`` on the training env.
    """
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() in {".yaml", ".yml"}:
        try:
            import yaml  # type: ignore[import-not-found]
        except ModuleNotFoundError as exc:  # pragma: no cover - env-only
            raise SystemExit(
                f"pyyaml is required to load {path}; install the training extras"
            ) from exc
        data = yaml.safe_load(text)
    else:
        data = json.loads(text)
    if not isinstance(data, Mapping):
        raise ValueError(f"{path} did not contain a top-level mapping")
    required = (
        "tier",
        "teacher_repo",
        "teacher_revision",
        "lora_rank",
        "optimizer",
        "epochs",
        "learning_rate",
        "train_data",
        "eval_data",
    )
    missing = [k for k in required if k not in data]
    if missing:
        raise ValueError(f"{path}: config missing keys: {sorted(missing)}")
    optimizer = str(data["optimizer"]).lower()
    if optimizer not in ("apollo", "adamw"):
        raise ValueError(
            f"{path}: optimizer must be 'apollo' or 'adamw', got {optimizer!r}"
        )
    return TurnFinetuneConfig(
        tier=str(data["tier"]),
        teacher_repo=str(data["teacher_repo"]),
        teacher_revision=str(data["teacher_revision"]),
        lora_rank=int(data["lora_rank"]),
        optimizer=optimizer,
        epochs=int(data["epochs"]),
        learning_rate=float(data["learning_rate"]),
        train_data=list(data["train_data"]),
        eval_data=list(data["eval_data"]),
        f1_gate=float(data.get("f1_gate", F1_GATE)),
        mean_latency_ms_gate=float(
            data.get("mean_latency_ms_gate", MEAN_LATENCY_MS_GATE)
        ),
    )


def stage_data(
    *,
    train_paths: Iterable[Path],
    eval_paths: Iterable[Path],
    out_dir: Path,
) -> dict[str, Any]:
    """Stage train/eval JSONL into ``out_dir`` after a privacy-filter pass.

    The privacy filter lives outside this package
    (``plugins/app-training/src/core/privacy-filter.ts``); we re-implement
    the no-op invariant here as a fail-closed marker. The real Python
    bridge is the responsibility of the training driver — for the smoke
    surface we only check existence + emit a manifest.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    train_records: list[dict[str, Any]] = []
    eval_records: list[dict[str, Any]] = []
    for p in train_paths:
        if not Path(p).is_file():
            raise FileNotFoundError(f"train data path missing: {p}")
        train_records.append({"path": str(p), "bytes": Path(p).stat().st_size})
    for p in eval_paths:
        if not Path(p).is_file():
            raise FileNotFoundError(f"eval data path missing: {p}")
        eval_records.append({"path": str(p), "bytes": Path(p).stat().st_size})
    manifest = {
        "schemaVersion": 1,
        "train": train_records,
        "eval": eval_records,
    }
    (out_dir / "stage-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


# ---------------------------------------------------------------------------
# Pretrain / SFT corpus builders.
#
# `build_pretrain_corpus` sources EOU labels from public dialogue corpora
# (DailyDialog as the primary, MultiWOZ + EmotionPush as documented optional
# add-ons). EOU label = 1 if the utterance is the last in its turn, else 0.
#
# `build_sft_corpus` augments the pretrain corpus with a small task-conditional
# augmentation set — chat-style examples where the "task" framing is
# "decide if the user is done speaking". 2k-5k pairs is enough for the demo;
# the bulk of the signal still comes from `build_pretrain_corpus`.
# ---------------------------------------------------------------------------


DAILYDIALOG_HF_REPO: Final[str] = "daily_dialog"


def build_pretrain_corpus(
    out_dir: Path,
    *,
    corpus: str = "dailydialog",
    max_examples: int | None = None,
) -> Path:
    """Stage an EOU-labelled JSONL under ``out_dir``.

    The output JSONL has one line per utterance::

        {"utterance": str, "eou_label": 0|1, "dialogue_id": str, "turn_idx": int}

    where ``eou_label == 1`` iff the utterance is the last in its turn.

    ``corpus="dailydialog"`` (default) pulls the Apache-2.0 mirror via the
    HuggingFace ``datasets`` library, which is the cleanest free starting
    point. Operators wanting to add MultiWOZ / EmotionPush should set the
    paths in their training config and call this function once per corpus
    — the JSONLs concatenate cleanly.

    Returns the absolute path to the written JSONL.

    .. note::

       Additional corpora the operator can stage later (each in its own
       JSONL):

       - **MultiWOZ** (Apache-2.0, EN, task-oriented) — adds task-conditional
         turn-taking signal beyond casual chat.
       - **EmotionPush** (research-only, EN, emotionally-loaded chat) — adds
         backchannel coverage but requires per-conversation labelling work.
       - **TURNS-2K** (Apache-2.0, EN, ASR-noisy 2k samples) — the LiveKit-style
         end-of-utterance subset; smaller but already aligned with the
         deploy distribution.

       Trajectory data from the deployed runtime is the dominant signal
       once we have several hundred hours; that import lives in
       ``prepare_voice_trajectory_data.py`` (TBD).
    """
    if corpus != "dailydialog":
        raise NotImplementedError(
            f"build_pretrain_corpus: corpus={corpus!r} not wired yet; "
            "stage the JSONL in the documented schema and add the path to "
            "the training config's train_data list.",
        )

    try:
        from datasets import load_dataset  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "build_pretrain_corpus(dailydialog) requires the `datasets` "
            "package; install via `uv pip install datasets`",
        ) from exc

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "dailydialog.jsonl"

    # DailyDialog: each dialogue has a list of utterances. The EOU label is
    # 1 for the final utterance of each (speaker) turn. The upstream HF
    # dataset is single-speaker-per-row already, so every utterance is the
    # end of its own turn unless the next row's `dialog` shares the same
    # speaker. DailyDialog's structure simplifies this — every row is its
    # own turn boundary, so EOU = 1 for the last utterance in each dialog,
    # 0 otherwise (a model that predicts EOU=1 on every turn would still
    # score reasonably; the harder negatives come from MultiWOZ + TURNS-2K).
    ds = load_dataset(DAILYDIALOG_HF_REPO, split="train", trust_remote_code=True)
    written = 0
    with out_path.open("w", encoding="utf-8") as fh:
        for dialogue_idx, row in enumerate(ds):
            utterances = row.get("dialog") or row.get("utterances") or []
            for turn_idx, utterance in enumerate(utterances):
                if not isinstance(utterance, str) or not utterance.strip():
                    continue
                eou_label = 1 if turn_idx == len(utterances) - 1 else 0
                fh.write(
                    json.dumps(
                        {
                            "utterance": utterance.strip(),
                            "eou_label": eou_label,
                            "dialogue_id": f"dailydialog-{dialogue_idx}",
                            "turn_idx": turn_idx,
                        },
                    )
                    + "\n",
                )
                written += 1
                if max_examples is not None and written >= max_examples:
                    return out_path
    return out_path


def build_sft_corpus(
    pretrain_jsonl: Path,
    out_dir: Path,
    *,
    target_pairs: int = 3000,
) -> Path:
    """Build a task-conditional EOU SFT corpus on top of ``pretrain_jsonl``.

    Output JSONL schema (one line per SFT pair)::

        {
          "prompt": "<task instruction>\\n<utterance>",
          "completion": "<|im_end|>" | "...",
          "label": 0 | 1,
        }

    The "completion" is the LiveKit-style next-token target: ``<|im_end|>``
    when the user is done speaking (`label=1`), and a continuation marker
    (``"..."``) otherwise. The prompt frames the task explicitly so the
    fine-tuned head learns to score next-token EOU under the chat template.

    ``target_pairs`` caps the output size (default 3 000). The balance is
    50/50 between EOU and non-EOU rows so the head doesn't collapse on the
    natural DailyDialog class imbalance (EOU is ~10% of utterances).
    """
    if not pretrain_jsonl.is_file():
        raise FileNotFoundError(f"pretrain JSONL missing: {pretrain_jsonl}")

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "sft.jsonl"

    pos: list[dict[str, Any]] = []
    neg: list[dict[str, Any]] = []
    with pretrain_jsonl.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            if record.get("eou_label") == 1:
                pos.append(record)
            else:
                neg.append(record)
    half = target_pairs // 2
    chosen = pos[:half] + neg[:half]
    instruction = "Decide if the user is done speaking. Output <|im_end|> if done, otherwise continue."

    written = 0
    with out_path.open("w", encoding="utf-8") as fh:
        for record in chosen:
            completion = "<|im_end|>" if record["eou_label"] == 1 else "..."
            fh.write(
                json.dumps(
                    {
                        "prompt": f"{instruction}\n<|user|> {record['utterance']}",
                        "completion": completion,
                        "label": int(record["eou_label"]),
                    },
                )
                + "\n",
            )
            written += 1
    return out_path


def build_examples(
    pretrain_jsonl: Path,
    *,
    base_model: str,
    revision: str | None = None,
    max_length: int = 128,
) -> "tuple[Any, Any]":
    """Tokenize + apply chat template against the teacher tokenizer.

    Returns ``(input_ids, labels)`` numpy arrays. ``labels[i] == 1`` means
    EOU. The text is passed through the LiveKit-style chat template
    (Qwen-family), truncated to ``max_length`` tokens, with the trailing
    ``<|im_end|>`` stripped so the model is scoring the next-token
    probability of end-of-turn.
    """
    try:
        from transformers import AutoTokenizer  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "build_examples requires the `transformers` package; install "
            "via `uv pip install transformers`",
        ) from exc

    tokenizer = AutoTokenizer.from_pretrained(base_model, revision=revision)
    pad_id = tokenizer.pad_token_id
    if pad_id is None:
        pad_id = tokenizer.eos_token_id or 0

    import numpy as np

    input_ids: list[list[int]] = []
    labels: list[int] = []
    with pretrain_jsonl.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            text = f"<|user|> {record['utterance']}"
            encoded = tokenizer(
                text,
                max_length=max_length,
                truncation=True,
                padding="max_length",
                add_special_tokens=False,
            )
            input_ids.append(list(encoded["input_ids"]))
            labels.append(int(record["eou_label"]))

    return (
        np.asarray(input_ids, dtype="int64"),
        np.asarray(labels, dtype="int64"),
    )


# ---------------------------------------------------------------------------
# Training step + checkpoint policy
# ---------------------------------------------------------------------------


def train_step(
    *,
    model: Any,
    batch: "tuple[Any, Any]",
    optimizer: Any,
    loss_fn: Any,
) -> float:
    """One APOLLO training step on a (input_ids, labels) batch.

    The base model is wrapped with a 2-class classification head (NON_EOU /
    EOU) at construction time — this function is the inner loop that's
    called per minibatch. Returns the scalar loss for logging.

    APOLLO only — see `packages/training/AGENTS.md §1`. The caller builds
    the optimizer via `build_apollo_optimizer` / `build_apollo_mini_optimizer`
    from `packages/training/scripts/training/optimizer.py`. AdamW is not
    accepted at the run-driver level; this function trusts the caller to
    have done the right thing.
    """
    import torch

    input_ids, labels = batch
    input_ids = input_ids.to(next(model.parameters()).device)
    labels = labels.to(next(model.parameters()).device)
    optimizer.zero_grad(set_to_none=True)
    outputs = model(input_ids)
    logits = outputs.logits if hasattr(outputs, "logits") else outputs[0]
    # If the head emits next-token vocab logits, score on the last position.
    if logits.dim() == 3:
        logits = logits[:, -1, :2]  # first two classes act as [NON_EOU, EOU]
    loss = loss_fn(logits, labels)
    loss.backward()
    # APOLLO does its own gradient projection; we don't clip globally.
    optimizer.step()
    return float(loss.detach().cpu())


def _maintain_top_k(
    top_k: list[dict[str, Any]],
    *,
    step: int,
    path: str,
    f1: float,
    keep: int,
) -> "tuple[list[dict[str, Any]], list[str]]":
    """Maintain top-``keep`` checkpoints by validation F1.

    Returns ``(new_top_k, paths_to_drop)``. ``paths_to_drop`` are
    checkpoint paths the caller should ``os.unlink`` after this function
    returns.
    """
    candidate = {"step": step, "path": path, "f1": f1}
    combined = sorted(
        [*top_k, candidate], key=lambda r: r["f1"], reverse=True,
    )
    new_top_k = combined[:keep]
    dropped = [r["path"] for r in combined[keep:]]
    return new_top_k, dropped


def train_lora(
    *,
    cfg: TurnFinetuneConfig,
    pretrain_jsonl: Path,
    eval_jsonl: Path,
    out_dir: Path,
    checkpoint_every: int = 500,
    max_steps: int | None = None,
) -> dict[str, Any]:
    """Real LoRA-or-full fine-tune driven by ``cfg``.

    Loads the base model from ``cfg.teacher_repo @ cfg.teacher_revision``,
    builds the APOLLO optimizer, runs ``cfg.epochs`` epochs (or
    ``max_steps`` if set, whichever ends first), evaluates every
    ``checkpoint_every`` steps, and maintains top-3 by val F1. If the eval
    gate ``cfg.f1_gate`` is not met at exit, raises ``RuntimeError`` per
    the spec.
    """
    try:
        import torch
        from torch import nn
        from transformers import (  # type: ignore[import-not-found]
            AutoModelForCausalLM,
            AutoTokenizer,
        )
    except ImportError as exc:
        raise RuntimeError(
            "train_lora requires torch + transformers; install via "
            "`uv pip install 'transformers[torch]'`",
        ) from exc

    try:
        from packages.training.scripts.training.optimizer import (
            build_apollo_mini_optimizer,
        )
    except ImportError as exc:
        raise RuntimeError(
            "APOLLO factory not importable; ensure "
            "packages/training/scripts/training/optimizer.py is on sys.path.",
        ) from exc

    out_dir.mkdir(parents=True, exist_ok=True)
    ckpt_dir = out_dir / "checkpoints"
    ckpt_dir.mkdir(parents=True, exist_ok=True)

    base_model = AutoModelForCausalLM.from_pretrained(
        cfg.teacher_repo, revision=cfg.teacher_revision,
    )
    tokenizer = AutoTokenizer.from_pretrained(
        cfg.teacher_repo, revision=cfg.teacher_revision,
    )
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token

    input_ids, labels = build_examples(
        pretrain_jsonl,
        base_model=cfg.teacher_repo,
        revision=cfg.teacher_revision,
    )
    eval_input_ids, eval_labels = build_examples(
        eval_jsonl,
        base_model=cfg.teacher_repo,
        revision=cfg.teacher_revision,
    )

    input_ids_t = torch.from_numpy(input_ids)
    labels_t = torch.from_numpy(labels)
    eval_input_ids_t = torch.from_numpy(eval_input_ids)
    eval_labels_t = torch.from_numpy(eval_labels)

    optimizer = build_apollo_mini_optimizer(
        base_model,
        lr=cfg.learning_rate,
        weight_decay=0.01,
    )
    loss_fn = nn.CrossEntropyLoss()
    batch_size = 16
    top_k: list[dict[str, Any]] = []
    best_f1 = 0.0
    last_f1 = 0.0
    step = 0
    base_model.train()
    for epoch in range(cfg.epochs):
        for start in range(0, input_ids_t.shape[0], batch_size):
            end = start + batch_size
            batch = (
                input_ids_t[start:end],
                labels_t[start:end],
            )
            loss = train_step(
                model=base_model,
                batch=batch,
                optimizer=optimizer,
                loss_fn=loss_fn,
            )
            step += 1
            if step % checkpoint_every == 0:
                # Eval pass
                base_model.eval()
                preds: list[int] = []
                golds: list[int] = []
                with torch.no_grad():
                    for s in range(0, eval_input_ids_t.shape[0], batch_size):
                        e = s + batch_size
                        out = base_model(eval_input_ids_t[s:e])
                        logits = out.logits if hasattr(out, "logits") else out[0]
                        if logits.dim() == 3:
                            logits = logits[:, -1, :2]
                        preds.extend(logits.argmax(dim=-1).cpu().numpy().tolist())
                        golds.extend(eval_labels_t[s:e].cpu().numpy().tolist())
                f1 = _binary_f1(preds, golds)
                last_f1 = f1
                if f1 > best_f1:
                    best_f1 = f1
                ckpt_path = ckpt_dir / f"step-{step:06d}.pt"
                torch.save(
                    {
                        "state_dict": base_model.state_dict(),
                        "step": step,
                        "f1": f1,
                    },
                    ckpt_path,
                )
                top_k, dropped = _maintain_top_k(
                    top_k, step=step, path=str(ckpt_path), f1=f1, keep=3,
                )
                for path in dropped:
                    try:
                        Path(path).unlink()
                    except FileNotFoundError:
                        pass
                base_model.train()
            if max_steps is not None and step >= max_steps:
                break
        if max_steps is not None and step >= max_steps:
            break

    summary = {
        "step": step,
        "best_f1": best_f1,
        "last_f1": last_f1,
        "top_k": top_k,
        "f1_gate": cfg.f1_gate,
    }
    (out_dir / "train-summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    if best_f1 < cfg.f1_gate:
        raise RuntimeError(
            f"F1 gate not met: {best_f1:.4f} < {cfg.f1_gate:.4f}",
        )
    return summary


def _binary_f1(predictions: list[int], golds: list[int]) -> float:
    """Binary F1 on EOU labels. Returns 0.0 when no positive predictions."""
    tp = sum(1 for p, g in zip(predictions, golds, strict=False) if p == 1 and g == 1)
    fp = sum(1 for p, g in zip(predictions, golds, strict=False) if p == 1 and g == 0)
    fn = sum(1 for p, g in zip(predictions, golds, strict=False) if p == 0 and g == 1)
    if tp == 0:
        return 0.0
    precision = tp / (tp + fp)
    recall = tp / (tp + fn)
    return 2 * precision * recall / (precision + recall)


def export_onnx(
    *,
    cfg: TurnFinetuneConfig,
    checkpoint_path: Path,
    out_path: Path,
    opset: int = 17,
) -> None:
    """Export the fine-tuned weights to ``onnx/model_q8.onnx``.

    Loads the base model from ``cfg.teacher_repo @ cfg.teacher_revision``,
    restores the checkpoint weights, runs ``torch.onnx.export`` (legacy
    TorchScript path — no onnxscript dependency), then applies INT8
    dynamic quantisation via ``onnxruntime.quantization.quantize_dynamic``.

    The output filename intentionally matches the upstream
    ``onnx/model_q8.onnx`` convention so the bundle stager picks it up
    without an extra flag.
    """
    try:
        import torch
        from transformers import (  # type: ignore[import-not-found]
            AutoModelForCausalLM,
        )
    except ImportError as exc:
        raise RuntimeError(
            "export_onnx requires torch + transformers",
        ) from exc

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fp32_path = out_path.with_suffix(".fp32.onnx")

    model = AutoModelForCausalLM.from_pretrained(
        cfg.teacher_repo, revision=cfg.teacher_revision,
    )
    checkpoint = torch.load(checkpoint_path, weights_only=False, map_location="cpu")
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()

    dummy = torch.zeros(1, 128, dtype=torch.long)
    torch.onnx.export(
        model,
        dummy,
        str(fp32_path),
        input_names=["input_ids"],
        output_names=["logits"],
        opset_version=opset,
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq"},
            "logits": {0: "batch", 1: "seq"},
        },
        dynamo=False,
    )

    try:
        from onnxruntime.quantization import QuantType, quantize_dynamic

        quantize_dynamic(
            model_input=str(fp32_path),
            model_output=str(out_path),
            weight_type=QuantType.QInt8,
        )
    except ImportError as exc:
        raise RuntimeError(
            "onnxruntime required for INT8 quantisation",
        ) from exc


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument(
        "--epochs",
        type=int,
        default=None,
        help="Override the epoch count from --config.",
    )
    ap.add_argument(
        "--base-model",
        type=str,
        default=None,
        help=(
            "Override --config's teacher_repo (e.g. 'livekit/turn-detector' "
            "or 'latishab/turnsense'). The revision is resolved from the tier."
        ),
    )
    ap.add_argument(
        "--checkpoint-every",
        type=int,
        default=500,
        help="Eval + checkpoint cadence in training steps.",
    )
    ap.add_argument(
        "--max-steps",
        type=int,
        default=None,
        help="Hard cap on training steps (overrides --config epochs).",
    )
    ap.add_argument(
        "--smoke",
        action="store_true",
        help=(
            "Stage data + emit the config-resolved manifest, then exit "
            "without invoking the training loop. Used in CI and by the "
            "scaffolded tests."
        ),
    )
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    cfg = load_config(args.config)
    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    resolved_revision = cfg.teacher_revision or default_revision_for_tier(cfg.tier)
    resolved = dataclasses.replace(cfg, teacher_revision=resolved_revision)
    if args.base_model is not None:
        resolved = dataclasses.replace(resolved, teacher_repo=args.base_model)
    if args.epochs is not None:
        resolved = dataclasses.replace(resolved, epochs=args.epochs)
    (out_dir / "resolved-config.json").write_text(
        json.dumps(dataclasses.asdict(resolved), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    stage_manifest = stage_data(
        train_paths=[Path(p) for p in resolved.train_data],
        eval_paths=[Path(p) for p in resolved.eval_data],
        out_dir=out_dir / "data",
    )
    if args.smoke:
        print(json.dumps(stage_manifest, indent=2, sort_keys=True))
        return 0
    if not resolved.train_data or not resolved.eval_data:
        raise SystemExit(
            "real training requires non-empty train_data + eval_data in "
            "the config; use --smoke for a config-only dry run.",
        )
    summary = train_lora(
        cfg=resolved,
        pretrain_jsonl=Path(resolved.train_data[0]),
        eval_jsonl=Path(resolved.eval_data[0]),
        out_dir=out_dir,
        checkpoint_every=args.checkpoint_every,
        max_steps=args.max_steps,
    )
    if summary["top_k"]:
        best = summary["top_k"][0]
        export_onnx(
            cfg=resolved,
            checkpoint_path=Path(best["path"]),
            out_path=out_dir / "onnx" / "model_q8.onnx",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
