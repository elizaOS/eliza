#!/usr/bin/env python3
"""Fine-tune the Eliza-1 semantic end-of-turn (EOT) detector.

This is the scaffolded entrypoint for the workflow specified in
[``.swarm/research/R1-turn.md``][R1] §5. It implements the LoRA / APOLLO
fine-tune path against the LiveKit Turn Detector ONNX export (the default
ship target) and the Apache-2.0 ``latishab/turnsense`` fallback.

[R1]: ../../../../.swarm/research/R1-turn.md

Pipeline (each step is a function below; ``--help`` lists the flags):

  1. Resolve the config YAML — `load_config()`. The config pins the
     teacher repo / revision, the LoRA rank, optimizer choice (APOLLO or
     AdamW), and the eval thresholds.
  2. Stage TURNS-2K + the Easy Turn testset under
     ``packages/training/data/turn/`` — `stage_data()`. Apply the
     privacy filter on every transcript record.
  3. Tokenize against the upstream tokenizer + apply the Qwen chat
     template — `build_examples()`.
  4. Train — `train_lora()`. APOLLO is preferred (gradient-low-rank
     projection beats AdamW under our throughput budget per the APOLLO
     paper); fall back to AdamW if `apollo-py` is not available.
  5. Export — `export_onnx()`. Re-quantizes to INT8 (`onnx/model_q8.onnx`),
     matches the upstream filename so the bundle stager picks it up
     without an extra flag.
  6. Evaluate via `eval_turn_detector.py` — the gate
     (F1 ≥ 0.85 and meanLatencyMs ≤ 30) is what decides publish-ability.

This file is intentionally a runnable *skeleton* — the heavy training
steps raise `NotImplementedError` until the real recipe lands. The
config-IO + smoke surface is real and tested.
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


def build_examples(*_args: Any, **_kwargs: Any) -> None:
    """Tokenize + apply chat template against the teacher tokenizer.

    Not implemented in the scaffold. The real version uses
    ``transformers.AutoTokenizer`` against the teacher repo + revision,
    truncates to 128 tokens (LiveKit upstream), and strips the trailing
    ``<|im_end|>`` so the model is scoring the next-token probability of
    end-of-turn.
    """
    raise NotImplementedError(
        "build_examples is scaffold-only; implement when the real finetune "
        "lands. See R1 §5 for the recipe."
    )


def train_lora(*_args: Any, **_kwargs: Any) -> None:
    """LoRA fine-tune loop with APOLLO or AdamW.

    Not implemented in the scaffold; raises so a CI run wired to the real
    flag set fails loudly instead of silently emitting an untrained
    artifact.
    """
    raise NotImplementedError(
        "train_lora is scaffold-only; implement when the real finetune "
        "lands. See R1 §5 for the recipe."
    )


def export_onnx(*_args: Any, **_kwargs: Any) -> None:
    """Export the fine-tuned weights to ``onnx/model_q8.onnx``.

    Not implemented in the scaffold.
    """
    raise NotImplementedError(
        "export_onnx is scaffold-only; implement when the real finetune "
        "lands. See R1 §5 for the recipe."
    )


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
        "--smoke",
        action="store_true",
        help=(
            "Stage data + emit the config-resolved manifest, then exit "
            "without invoking the (unimplemented) training loop. Used in "
            "CI and by the scaffolded tests."
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
    # Real path — not implemented yet.
    train_lora()
    export_onnx()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
