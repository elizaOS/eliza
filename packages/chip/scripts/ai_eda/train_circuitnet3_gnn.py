#!/usr/bin/env python3
"""Train the CircuitNet 3.0 heterogeneous GNN timing/power surrogate (CPU).

Loads converted ``eda.graph_sample.v1`` records, builds a deterministic
sorted 80/10/10 case split (the same policy the mean-baseline uses), trains
``CircuitNetGNN`` against standardized design-level targets, then reports
held-out test MAE per target alongside the train-split mean-baseline evaluated
on the identical test cases. The point of the run is the head-to-head: a GNN
"win" is only claimed where measured test MAE beats the baseline.

Public CircuitNet pretraining only. No E1 PPA/signoff claim.
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import torch
from circuitnet3_gnn import (
    TARGETS,
    CircuitNetGNN,
    FeatureStats,
    GraphSample,
    compute_feature_stats,
    load_graph_samples,
    standardize_nodes,
)
from torch import Tensor

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RECORD_DIR = ROOT / "build/ai_eda/circuitnet3/validation/records"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/circuitnet3_gnn"
CLAIM_BOUNDARY = (
    "circuitnet3_surrogate_training_pretraining_only_no_e1_ppa_signoff_or_release_claim"
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def split_samples(samples: list[GraphSample]) -> dict[str, list[GraphSample]]:
    ordered = sorted(samples, key=lambda item: item.case_id)
    if len(ordered) < 10:
        if len(ordered) < 3:
            raise SystemExit(
                "STATUS: BLOCKED ai_eda.circuitnet3_gnn need_at_least_3_graph_samples "
                f"have={len(ordered)} "
                "convert more cases: make ai-eda-circuitnet3-convert (or --all-records)"
            )
        return {"train": ordered[:-2], "val": ordered[-2:-1], "test": ordered[-1:]}
    val_count = max(1, round(len(ordered) * 0.1))
    test_count = max(1, round(len(ordered) * 0.1))
    train_count = len(ordered) - val_count - test_count
    return {
        "train": ordered[:train_count],
        "val": ordered[train_count : train_count + val_count],
        "test": ordered[train_count + val_count :],
    }


def masked_loss(pred: Tensor, target: Tensor, mask: Tensor) -> Tensor:
    diff = (pred - target) * mask
    denom = mask.sum().clamp_min(1.0)
    return (diff * diff).sum() / denom


def train_gnn(
    train: list[GraphSample],
    val: list[GraphSample],
    stats: FeatureStats,
    *,
    epochs: int,
    lr: float,
    seed: int,
    patience: int,
) -> tuple[CircuitNetGNN, int]:
    torch.manual_seed(seed)
    model = CircuitNetGNN()
    optimizer = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=1e-4)
    train_nodes = [standardize_nodes(sample, stats) for sample in train]
    train_targets = [(sample.targets - stats.target_mean) / stats.target_std for sample in train]
    best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
    best_val = float("inf")
    best_epoch = 0
    stale = 0
    val_pairs = [
        (standardize_nodes(sample, stats), (sample.targets - stats.target_mean) / stats.target_std)
        for sample in val
    ]
    for epoch in range(1, epochs + 1):
        model.train()
        order = torch.randperm(len(train))
        train_loss = 0.0
        for idx in order.tolist():
            sample = train[idx]
            optimizer.zero_grad()
            pred = model(train_nodes[idx], sample.node_family, sample.edge_index)
            loss = masked_loss(pred, train_targets[idx], sample.target_mask.float())
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            train_loss += loss.item()
        train_loss /= max(len(train), 1)
        if not val_pairs:
            best_epoch = epoch
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            print(f"[gnn] epoch={epoch} train_loss={train_loss:.5f}", flush=True)
            continue
        model.eval()
        with torch.no_grad():
            val_loss = sum(
                masked_loss(
                    model(nodes, sample.node_family, sample.edge_index),
                    target,
                    sample.target_mask.float(),
                ).item()
                for (nodes, target), sample in zip(val_pairs, val, strict=True)
            ) / len(val_pairs)
        improved = val_loss < best_val
        if improved:
            best_val = val_loss
            best_epoch = epoch
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            stale = 0
        else:
            stale += 1
        print(
            f"[gnn] epoch={epoch} train_loss={train_loss:.5f} val_loss={val_loss:.5f} "
            f"best={best_val:.5f}@{best_epoch}",
            flush=True,
        )
        if stale >= patience:
            print(f"[gnn] early stop at epoch={epoch} (patience={patience})", flush=True)
            break
    model.load_state_dict(best_state)
    return model, best_epoch


def mean_baseline(train: list[GraphSample]) -> dict[str, float]:
    totals = torch.zeros(len(TARGETS))
    counts = torch.zeros(len(TARGETS))
    for sample in train:
        mask = sample.target_mask.float()
        totals += sample.targets * mask
        counts += mask
    means = totals / counts.clamp_min(1.0)
    return {target: float(means[i]) for i, target in enumerate(TARGETS)}


def evaluate(
    model: CircuitNetGNN,
    samples: list[GraphSample],
    stats: FeatureStats,
    baseline: dict[str, float],
) -> dict[str, Any]:
    model.eval()
    abs_err_gnn: dict[str, list[float]] = {t: [] for t in TARGETS}
    abs_err_base: dict[str, list[float]] = {t: [] for t in TARGETS}
    with torch.no_grad():
        for sample in samples:
            nodes = standardize_nodes(sample, stats)
            pred_std = model(nodes, sample.node_family, sample.edge_index)
            pred = pred_std * stats.target_std + stats.target_mean
            for i, target in enumerate(TARGETS):
                if not bool(sample.target_mask[i]):
                    continue
                actual = float(sample.targets[i])
                abs_err_gnn[target].append(abs(float(pred[i]) - actual))
                abs_err_base[target].append(abs(baseline[target] - actual))
    targets_out: dict[str, Any] = {}
    for target in TARGETS:
        gnn_errs = abs_err_gnn[target]
        base_errs = abs_err_base[target]
        gnn_mae = sum(gnn_errs) / len(gnn_errs) if gnn_errs else None
        base_mae = sum(base_errs) / len(base_errs) if base_errs else None
        improvement = (
            round((base_mae - gnn_mae) / base_mae, 6)
            if gnn_mae is not None and base_mae is not None and base_mae != 0.0
            else None
        )
        targets_out[target] = {
            "sample_count": len(gnn_errs),
            "gnn_mae": round(gnn_mae, 8) if gnn_mae is not None else None,
            "baseline_mae": round(base_mae, 8) if base_mae is not None else None,
            "gnn_beats_baseline": (
                bool(gnn_mae < base_mae) if gnn_mae is not None and base_mae is not None else None
            ),
            "relative_improvement": improvement,
        }
    return {"sample_count": len(samples), "targets": targets_out}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record-dir", action="append", type=Path, default=[])
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--epochs", type=int, default=200)
    parser.add_argument("--lr", type=float, default=5e-3)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--patience", type=int, default=20)
    parser.add_argument(
        "--max-cases",
        type=int,
        default=0,
        help="Cap the number of (sorted) cases used; 0 = use all converted cases.",
    )
    return parser.parse_args()


def main() -> int:
    # The graphs are small (hundreds to a few thousand nodes); multi-thread BLAS
    # dispatch overhead dominates per-op cost and is ~25x slower than single
    # threaded on this workload, so pin to one thread.
    torch.set_num_threads(1)
    args = parse_args()
    record_dirs = args.record_dir or [DEFAULT_RECORD_DIR]
    samples = load_graph_samples(record_dirs)
    if not samples:
        print(
            "STATUS: BLOCKED ai_eda.circuitnet3_gnn no_graph_samples "
            f"dirs={[rel(p) for p in record_dirs]} "
            "run: make ai-eda-circuitnet3-convert"
        )
        return 2
    if args.max_cases > 0:
        samples = sorted(samples, key=lambda item: item.case_id)[: args.max_cases]
    splits = split_samples(samples)
    stats = compute_feature_stats(splits["train"])
    model, best_epoch = train_gnn(
        splits["train"],
        splits["val"],
        stats,
        epochs=args.epochs,
        lr=args.lr,
        seed=args.seed,
        patience=args.patience,
    )
    baseline = mean_baseline(splits["train"])
    evaluations = {split: evaluate(model, rows, stats, baseline) for split, rows in splits.items()}

    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    model_path = out_dir / "circuitnet3_gnn_model.pt"
    torch.save(
        {
            "state_dict": model.state_dict(),
            "node_mean": stats.node_mean,
            "node_std": stats.node_std,
            "target_mean": stats.target_mean,
            "target_std": stats.target_std,
            "targets": list(TARGETS),
        },
        model_path,
    )
    metrics_path = out_dir / "metrics.json"
    metrics = {
        "schema": "eliza.ai_eda.circuitnet3_gnn_metrics.v1",
        "claim_boundary": CLAIM_BOUNDARY,
        "model_type": "heterogeneous_message_passing_gnn",
        "baseline_compared": "train_split_mean_baseline",
        "targets": list(TARGETS),
        "splits": {
            split: {
                "sample_count": ev["sample_count"],
                "targets": ev["targets"],
            }
            for split, ev in evaluations.items()
        },
        "release_use_allowed": False,
    }
    metrics_path.write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    test_targets = evaluations["test"]["targets"]
    wins = sum(1 for t in test_targets.values() if t["gnn_beats_baseline"] is True)
    scored = sum(1 for t in test_targets.values() if t["gnn_beats_baseline"] is not None)
    run_path = out_dir / "training_run.json"
    run = {
        "schema": "eliza.ai_eda.circuitnet3_gnn_training_run.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "record_dirs": [rel(path) for path in record_dirs],
        "sample_count": len(samples),
        "split_counts": {split: len(rows) for split, rows in splits.items()},
        "split_policy": "deterministic_sorted_case_id_80_10_10_for_n_ge_10_else_holdout",
        "hyperparameters": {
            "epochs": args.epochs,
            "patience": args.patience,
            "best_epoch": best_epoch,
            "lr": args.lr,
            "seed": args.seed,
            "hidden_dim": 64,
            "num_layers": 3,
        },
        "model": rel(model_path),
        "metrics": rel(metrics_path),
        "test_targets_where_gnn_beats_baseline": wins,
        "test_targets_scored": scored,
        "release_use_allowed": False,
    }
    run_path.write_text(json.dumps(run, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.circuitnet3_gnn "
        f"samples={len(samples)} "
        f"train={len(splits['train'])} val={len(splits['val'])} test={len(splits['test'])} "
        f"test_wins_vs_baseline={wins}/{scored} {rel(run_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
