#!/usr/bin/env python3
"""Train a CUDA-capable PyTorch macro-placement regressor.

This consumes the supervised macro-placement JSONL splits and writes model,
metric, and run-report artifacts. It is intentionally a training artifact only:
candidate generation and OpenLane/OpenROAD replay remain handled by the
quarantined candidate/replay pipeline.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATASET_ROOT = ROOT / "build/ai_eda/macro_placement_supervised_dataset"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/macro_placement_torch_regressor"
CLAIM_BOUNDARY = (
    "macro_placement_torch_regressor_training_only_no_inference_replay_or_release_claim"
)
ORIENTATIONS = ("N", "S", "E", "W", "FN", "FS", "FE", "FW")


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def stable_unit(value: Any) -> float:
    digest = hashlib.sha256(str(value).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / float(2**64 - 1)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                data = json.loads(line)
                if not isinstance(data, dict):
                    raise ValueError(f"{path}: expected JSON object rows")
                rows.append(data)
    return rows


def sample_features(sample: dict[str, Any]) -> list[float]:
    obj = sample["object"]
    floorplan = sample["floorplan"]
    index = float(obj.get("index", 0.0) or 0.0)
    return [
        float(obj.get("width_over_core", 0.0) or 0.0),
        float(obj.get("height_over_core", 0.0) or 0.0),
        float(obj.get("width_um", 0.0) or 0.0) / max(float(floorplan["core_width_um"]), 1.0),
        float(obj.get("height_um", 0.0) or 0.0) / max(float(floorplan["core_height_um"]), 1.0),
        min(index / 512.0, 1.0),
        stable_unit(obj.get("macro_name", "")),
        stable_unit(obj.get("type", "")),
        stable_unit(sample.get("design_bundle_id", "")),
        float(floorplan["core_width_um"]) / max(float(floorplan["core_height_um"]), 1.0),
        float(floorplan["core_height_um"]) / max(float(floorplan["core_width_um"]), 1.0),
    ]


def import_torch() -> Any:
    try:
        import torch  # type: ignore[import-not-found]
    except ImportError as exc:
        raise SystemExit(
            "PyTorch is required for train_macro_placement_torch_regressor.py; "
            "install a CUDA-capable torch build on the remote training host."
        ) from exc
    return torch


def make_tensors(torch: Any, samples: list[dict[str, Any]], device: Any) -> tuple[Any, Any, Any]:
    features = [sample_features(sample) for sample in samples]
    xy = [
        [float(sample["label"]["x_over_core"]), float(sample["label"]["y_over_core"])]
        for sample in samples
    ]
    orientation_ids = [
        ORIENTATIONS.index(str(sample["label"].get("orientation", "N")))
        if str(sample["label"].get("orientation", "N")) in ORIENTATIONS
        else 0
        for sample in samples
    ]
    return (
        torch.tensor(features, dtype=torch.float32, device=device),
        torch.tensor(xy, dtype=torch.float32, device=device),
        torch.tensor(orientation_ids, dtype=torch.long, device=device),
    )


def build_model(torch: Any) -> Any:
    return torch.nn.Sequential(
        torch.nn.Linear(10, 64),
        torch.nn.ReLU(),
        torch.nn.Linear(64, 64),
        torch.nn.ReLU(),
        torch.nn.Linear(64, 2 + len(ORIENTATIONS)),
    )


def evaluate(
    torch: Any, model: Any, samples: list[dict[str, Any]], device: Any, split: str
) -> dict[str, Any]:
    if not samples:
        return {"split": split, "sample_count": 0}
    features, xy, orientation_ids = make_tensors(torch, samples, device)
    model.eval()
    with torch.no_grad():
        output = model(features)
        pred_xy = output[:, :2].clamp(0.0, 1.0)
        pred_orientation = output[:, 2:].argmax(dim=1)
        abs_error = (pred_xy - xy).abs()
        orientation_acc = (pred_orientation == orientation_ids).float().mean().item()
    return {
        "split": split,
        "sample_count": len(samples),
        "mae_x_over_core": round(float(abs_error[:, 0].mean().item()), 8),
        "mae_y_over_core": round(float(abs_error[:, 1].mean().item()), 8),
        "mean_l1_over_core": round(float(abs_error.mean().item()), 8),
        "orientation_accuracy": round(float(orientation_acc), 8),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--dataset-root", type=Path, default=DEFAULT_DATASET_ROOT)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda", "mps"), default="auto")
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--seed", type=int, default=20260520)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    torch = import_torch()
    torch.manual_seed(args.seed)
    if args.device == "cuda" and not torch.cuda.is_available():
        print("STATUS: FAIL ai_eda.macro_placement_torch_regressor cuda requested but unavailable")
        return 1
    mps_available = bool(
        hasattr(torch.backends, "mps")
        and torch.backends.mps.is_available()
        and torch.backends.mps.is_built()
    )
    if args.device == "mps" and not mps_available:
        print("STATUS: FAIL ai_eda.macro_placement_torch_regressor mps requested but unavailable")
        return 1
    if args.device == "auto" and torch.cuda.is_available():
        device_name = "cuda"
    elif args.device == "auto" and mps_available:
        device_name = "mps"
    else:
        device_name = args.device
    if device_name == "auto":
        device_name = "cpu"
    device = torch.device(device_name)

    dataset_dir = args.dataset_root / args.run_id
    train_samples = load_jsonl(dataset_dir / "train.jsonl")
    val_samples = load_jsonl(dataset_dir / "val.jsonl")
    test_samples = load_jsonl(dataset_dir / "test.jsonl")
    if not train_samples:
        print("STATUS: FAIL ai_eda.macro_placement_torch_regressor empty training split")
        return 1

    features, xy, orientation_ids = make_tensors(torch, train_samples, device)
    model = build_model(torch).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate)
    xy_loss = torch.nn.SmoothL1Loss()
    orientation_loss = torch.nn.CrossEntropyLoss()

    loss_history = []
    for epoch in range(args.epochs):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        output = model(features)
        loss = xy_loss(output[:, :2].contiguous(), xy) + 0.1 * orientation_loss(
            output[:, 2:].contiguous(),
            orientation_ids,
        )
        loss.backward()
        optimizer.step()
        if epoch == 0 or epoch == args.epochs - 1 or (epoch + 1) % 10 == 0:
            loss_history.append({"epoch": epoch + 1, "loss": round(float(loss.item()), 8)})

    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    model_path = out_dir / "torch_regressor.pt"
    torch.save(
        {
            "model_state_dict": model.state_dict(),
            "feature_schema": [
                "width_over_core",
                "height_over_core",
                "width_um_over_core_width",
                "height_um_over_core_height",
                "index_over_512",
                "macro_name_hash_unit",
                "type_hash_unit",
                "design_bundle_hash_unit",
                "core_aspect_width_over_height",
                "core_aspect_height_over_width",
            ],
            "orientations": ORIENTATIONS,
            "claim_boundary": CLAIM_BOUNDARY,
        },
        model_path,
    )

    metrics = {
        "schema": "eliza.ai_eda.macro_placement_torch_regressor_metrics.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "device": str(device),
        "epochs": args.epochs,
        "splits": [
            evaluate(torch, model, train_samples, device, "train"),
            evaluate(torch, model, val_samples, device, "val"),
            evaluate(torch, model, test_samples, device, "test"),
        ],
        "loss_history": loss_history,
        "release_use_allowed": False,
    }
    metrics_path = out_dir / "metrics.json"
    metrics_path.write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    report = {
        "schema": "eliza.ai_eda.macro_placement_torch_regressor_training_run.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "dataset_dir": rel(dataset_dir),
        "model": rel(model_path),
        "metrics": rel(metrics_path),
        "train_sample_count": len(train_samples),
        "val_sample_count": len(val_samples),
        "test_sample_count": len(test_samples),
        "device": str(device),
        "epochs": args.epochs,
        "next_required_gates": [
            "add graph connectivity and netlist-aware features",
            "emit quarantined candidates through the existing candidate manifest contract",
            "compare against deterministic baselines under OpenLane/OpenROAD replay",
        ],
        "release_use_allowed": False,
    }
    report_path = out_dir / "torch_training_run.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.macro_placement_torch_regressor "
        f"device={device} train={len(train_samples)} val={len(val_samples)} "
        f"test={len(test_samples)} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
