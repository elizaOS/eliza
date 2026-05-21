#!/usr/bin/env python3
"""Train a heterogeneous GNN PD surrogate over CircuitNet3 graph records.

This consumes `eda.graph_sample.v1` records produced by
`convert_circuitnet3_to_internal_records.py` and trains a message-passing graph
neural network that predicts graph-level physical-design metrics (timing slack,
arrival time, delay, slew, fanout, setup, total power). Message passing is
hand-rolled in pure PyTorch (segment-sum scatter aggregation over the timing-arc
edge list) so the model has no `torch_geometric` dependency and stays portable
across CPU smoke runs and a later CUDA (Nebius H200) training host.

The model is an advisory pretraining artifact only. CircuitNet labels are public
dataset exports, not E1 OpenLane/OpenROAD signoff. The script writes a held-out
evaluation split by design id (no case leakage), per-target MAE with error bars,
the held-out design id list, and an explicit claim boundary. It never asserts E1
PPA signoff or release readiness.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RECORD_DIR = ROOT / "build/ai_eda/circuitnet3/linux-maxtrain-20260521/records"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/pd_surrogates"
CLAIM_BOUNDARY = "circuitnet3_gnn_training_pretraining_only_no_e1_ppa_signoff_or_release_claim"

TARGETS = (
    "min_slack",
    "mean_slack",
    "max_at",
    "mean_delay",
    "mean_slew",
    "mean_setup",
    "mean_fanout",
    "total_power",
)
NODE_NUMERIC_FEATURES = (
    "drive_strength",
    "fanout_num",
    "fanout_res",
    "fanout_load_mean",
    "at",
    "slack",
    "setup_mean",
)
EDGE_NUMERIC_FEATURES = ("delay_mean", "slew_mean")


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    parsed = float(value)
    return parsed if math.isfinite(parsed) else None


def stable_unit(value: Any) -> float:
    digest = hashlib.sha256(str(value).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / float(2**64 - 1)


def load_samples(record_dirs: list[Path], max_nodes: int) -> list[dict[str, Any]]:
    """Load `eda.graph_sample.v1` records into compact graph dicts.

    Node feature columns carry a paired presence-mask column so a missing
    timing value (null `slack`/`at` on cells without a captured arc) is encoded
    as zero-with-mask rather than silently imputed as a real measurement.
    """
    samples: list[dict[str, Any]] = []
    for record_dir in record_dirs:
        if not record_dir.exists():
            continue
        for path in sorted(record_dir.glob("*graph-sample.json")):
            record = load_json(path)
            if record.get("schema") != "eda.graph_sample.v1":
                continue
            graph = record.get("graph")
            label_values = record.get("labels", {}).get("values")
            if not isinstance(graph, dict) or not isinstance(label_values, dict):
                continue
            node_list = graph.get("node_features")
            edge_list = graph.get("edge_features")
            if not isinstance(node_list, list) or not node_list or not isinstance(edge_list, list):
                continue

            node_index: dict[str, int] = {}
            node_features: list[list[float]] = []
            for node in node_list:
                if not isinstance(node, dict):
                    continue
                node_id = str(node.get("id"))
                node_index[node_id] = len(node_features)
                row: list[float] = [stable_unit(node.get("cell_name", "UNKNOWN"))]
                for key in NODE_NUMERIC_FEATURES:
                    value = finite(node.get(key))
                    row.append(0.0 if value is None else value)
                    row.append(0.0 if value is None else 1.0)
                node_features.append(row)

            edge_src: list[int] = []
            edge_dst: list[int] = []
            edge_features: list[list[float]] = []
            for edge in edge_list:
                if not isinstance(edge, dict):
                    continue
                src_node = str(edge.get("src", "")).split(".", 1)[0]
                dst_node = str(edge.get("dst", "")).split(".", 1)[0]
                if src_node not in node_index or dst_node not in node_index:
                    continue
                edge_src.append(node_index[src_node])
                edge_dst.append(node_index[dst_node])
                row = []
                for key in EDGE_NUMERIC_FEATURES:
                    value = finite(edge.get(key))
                    row.append(0.0 if value is None else value)
                    row.append(0.0 if value is None else 1.0)
                edge_features.append(row)

            targets = {key: finite(label_values.get(key)) for key in TARGETS}
            targets = {key: value for key, value in targets.items() if value is not None}
            if not targets:
                continue

            samples.append(
                {
                    "id": str(record["id"]),
                    "design_id": str(record["design_bundle_id"]),
                    "source": rel(path),
                    "node_features": node_features,
                    "edge_src": edge_src,
                    "edge_dst": edge_dst,
                    "edge_features": edge_features,
                    "targets": targets,
                    "node_count": len(node_features),
                    "edge_count": len(edge_features),
                    "truncated": len(node_features) > max_nodes,
                }
            )
    return samples


def split_by_design_id(samples: list[dict[str, Any]], seed: int) -> dict[str, list[dict[str, Any]]]:
    """Deterministic 80/10/10 split keyed on a hash of the design id.

    A design id lands in exactly one split, so no case (and no node of a case)
    leaks between train, val, and test. The split is reproducible from the seed
    and design id alone, independent of file iteration order.
    """
    by_design: dict[str, list[dict[str, Any]]] = {}
    for sample in samples:
        by_design.setdefault(sample["design_id"], []).append(sample)
    design_ids = sorted(by_design)

    def bucket(design_id: str) -> str:
        unit = stable_unit(f"{seed}:{design_id}")
        if unit < 0.8:
            return "train"
        if unit < 0.9:
            return "val"
        return "test"

    splits: dict[str, list[dict[str, Any]]] = {"train": [], "val": [], "test": []}
    for design_id in design_ids:
        splits[bucket(design_id)].extend(by_design[design_id])
    if not splits["train"]:
        # Guarantee a non-empty training split for very small corpora by moving
        # the lexicographically first design into train.
        first = design_ids[0]
        moved = by_design[first]
        for name in ("val", "test"):
            splits[name] = [s for s in splits[name] if s["design_id"] != first]
        splits["train"] = moved
    return splits


def import_torch() -> Any:
    try:
        import torch  # type: ignore[import-not-found]
    except ImportError as exc:
        raise SystemExit(
            "PyTorch is required for train_pd_surrogates.py; install a CPU or "
            "CUDA-capable torch build before training."
        ) from exc
    return torch


def resolve_device(torch: Any, requested: str) -> Any:
    if requested == "cuda" and not torch.cuda.is_available():
        raise SystemExit("STATUS: FAIL ai_eda.pd_surrogates cuda requested but unavailable")
    if requested == "auto":
        requested = "cuda" if torch.cuda.is_available() else "cpu"
    return torch.device(requested)


def normalization(samples: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    """Per-target mean/std from the training split for label standardization."""
    stats: dict[str, dict[str, float]] = {}
    for target in TARGETS:
        values = [s["targets"][target] for s in samples if target in s["targets"]]
        if not values:
            continue
        mean = sum(values) / len(values)
        var = sum((v - mean) ** 2 for v in values) / len(values)
        stats[target] = {"mean": mean, "std": math.sqrt(var) if var > 0 else 1.0}
    return stats


class MessagePassingSurrogate:
    """Hand-rolled message-passing GNN with graph-level multi-target heads.

    Each layer transforms node + incident edge features into messages, scatters
    them to destination nodes by segment sum (mean-normalized by in-degree), and
    updates node states with a residual MLP block. A masked mean pool over node
    states produces the graph embedding consumed by per-target linear heads.
    """

    def __init__(self, torch: Any, node_dim: int, edge_dim: int, hidden: int, layers: int, target_keys: list[str]) -> None:
        self.torch = torch
        nn = torch.nn
        self.target_keys = target_keys
        self.node_encoder = nn.Sequential(nn.Linear(node_dim, hidden), nn.ReLU(), nn.Linear(hidden, hidden))
        self.message_layers = nn.ModuleList(
            [nn.Sequential(nn.Linear(2 * hidden + edge_dim, hidden), nn.ReLU(), nn.Linear(hidden, hidden)) for _ in range(layers)]
        )
        self.update_layers = nn.ModuleList(
            [nn.Sequential(nn.Linear(2 * hidden, hidden), nn.ReLU(), nn.Linear(hidden, hidden)) for _ in range(layers)]
        )
        self.head = nn.Linear(hidden, len(target_keys))
        self.module = nn.ModuleList(
            [self.node_encoder, self.message_layers, self.update_layers, self.head]
        )

    def parameters(self) -> Any:
        return self.module.parameters()

    def to(self, device: Any) -> MessagePassingSurrogate:
        self.module.to(device)
        return self

    def train(self) -> None:
        self.module.train()

    def eval(self) -> None:
        self.module.eval()

    def state_dict(self) -> Any:
        return self.module.state_dict()

    def forward(self, graph: dict[str, Any]) -> Any:
        torch = self.torch
        h = self.node_encoder(graph["nodes"])
        src = graph["edge_src"]
        dst = graph["edge_dst"]
        edge_attr = graph["edge_attr"]
        node_count = h.shape[0]
        if src.numel() > 0:
            in_degree = torch.zeros(node_count, device=h.device).index_add_(
                0, dst, torch.ones(dst.shape[0], device=h.device)
            )
            in_degree = in_degree.clamp(min=1.0).unsqueeze(1)
        for message_layer, update_layer in zip(self.message_layers, self.update_layers, strict=True):
            if src.numel() > 0:
                message_input = torch.cat([h[src], h[dst], edge_attr], dim=1)
                messages = message_layer(message_input)
                aggregated = torch.zeros(node_count, messages.shape[1], device=h.device)
                aggregated = aggregated.index_add_(0, dst, messages) / in_degree
            else:
                aggregated = torch.zeros_like(h)
            h = h + update_layer(torch.cat([h, aggregated], dim=1))
        pooled = h.mean(dim=0, keepdim=True)
        return self.head(pooled).squeeze(0)


def to_graph_tensors(torch: Any, sample: dict[str, Any], device: Any, max_nodes: int) -> dict[str, Any]:
    node_features = sample["node_features"][:max_nodes]
    kept = set(range(len(node_features)))
    edge_src: list[int] = []
    edge_dst: list[int] = []
    edge_attr: list[list[float]] = []
    for s, d, attr in zip(sample["edge_src"], sample["edge_dst"], sample["edge_features"], strict=True):
        if s in kept and d in kept:
            edge_src.append(s)
            edge_dst.append(d)
            edge_attr.append(attr)
    return {
        "nodes": torch.tensor(node_features, dtype=torch.float32, device=device),
        "edge_src": torch.tensor(edge_src, dtype=torch.long, device=device),
        "edge_dst": torch.tensor(edge_dst, dtype=torch.long, device=device),
        "edge_attr": torch.tensor(edge_attr, dtype=torch.float32, device=device)
        if edge_attr
        else torch.zeros((0, 2 * len(EDGE_NUMERIC_FEATURES)), dtype=torch.float32, device=device),
    }


def target_vector(torch: Any, sample: dict[str, Any], stats: dict[str, dict[str, float]], target_keys: list[str], device: Any) -> tuple[Any, Any]:
    values: list[float] = []
    mask: list[float] = []
    for key in target_keys:
        if key in sample["targets"]:
            stat = stats[key]
            values.append((sample["targets"][key] - stat["mean"]) / stat["std"])
            mask.append(1.0)
        else:
            values.append(0.0)
            mask.append(0.0)
    return (
        torch.tensor(values, dtype=torch.float32, device=device),
        torch.tensor(mask, dtype=torch.float32, device=device),
    )


def quantile(sorted_values: list[float], q: float) -> float:
    if not sorted_values:
        return float("nan")
    if len(sorted_values) == 1:
        return sorted_values[0]
    pos = q * (len(sorted_values) - 1)
    low = math.floor(pos)
    high = math.ceil(pos)
    if low == high:
        return sorted_values[low]
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (pos - low)


def evaluate(
    torch: Any,
    model: MessagePassingSurrogate,
    samples: list[dict[str, Any]],
    stats: dict[str, dict[str, float]],
    target_keys: list[str],
    baseline: dict[str, float],
    device: Any,
    max_nodes: int,
    split: str,
) -> dict[str, Any]:
    per_target_abs: dict[str, list[float]] = {key: [] for key in target_keys}
    baseline_abs: dict[str, list[float]] = {key: [] for key in target_keys}
    model.eval()
    with torch.no_grad():
        for sample in samples:
            graph = to_graph_tensors(torch, sample, device, max_nodes)
            pred = model.forward(graph)
            for idx, key in enumerate(target_keys):
                if key not in sample["targets"]:
                    continue
                stat = stats[key]
                pred_value = float(pred[idx].item()) * stat["std"] + stat["mean"]
                actual = sample["targets"][key]
                per_target_abs[key].append(abs(pred_value - actual))
                baseline_abs[key].append(abs(baseline[key] - actual))
    targets_report: dict[str, Any] = {}
    for key in target_keys:
        errors = sorted(per_target_abs[key])
        base_errors = baseline_abs[key]
        if not errors:
            continue
        mae = sum(errors) / len(errors)
        var = sum((e - mae) ** 2 for e in errors) / len(errors)
        targets_report[key] = {
            "sample_count": len(errors),
            "mae": round(mae, 8),
            "mae_std": round(math.sqrt(var), 8),
            "abs_error_p50": round(quantile(errors, 0.5), 8),
            "abs_error_p90": round(quantile(errors, 0.9), 8),
            "baseline_mae": round(sum(base_errors) / len(base_errors), 8) if base_errors else None,
        }
    return {"split": split, "sample_count": len(samples), "targets": targets_report}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record-dir", action="append", type=Path, default=[])
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--learning-rate", type=float, default=2e-3)
    parser.add_argument("--hidden", type=int, default=64)
    parser.add_argument("--layers", type=int, default=3)
    parser.add_argument("--max-nodes", type=int, default=1024)
    parser.add_argument("--seed", type=int, default=20260521)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.epochs <= 0:
        print("STATUS: FAIL ai_eda.pd_surrogates epochs must be positive")
        return 1
    if args.max_nodes <= 0:
        print("STATUS: FAIL ai_eda.pd_surrogates max-nodes must be positive")
        return 1

    record_dirs = args.record_dir or [DEFAULT_RECORD_DIR]
    samples = load_samples(record_dirs, args.max_nodes)
    if not samples:
        print("STATUS: FAIL ai_eda.pd_surrogates no_graph_samples")
        return 1

    splits = split_by_design_id(samples, args.seed)
    if not splits["train"]:
        print("STATUS: FAIL ai_eda.pd_surrogates empty_train_split")
        return 1

    torch = import_torch()
    torch.manual_seed(args.seed)
    device = resolve_device(torch, args.device)

    stats = normalization(splits["train"])
    target_keys = [key for key in TARGETS if key in stats]
    if not target_keys:
        print("STATUS: FAIL ai_eda.pd_surrogates no_trainable_targets")
        return 1
    baseline = {key: stats[key]["mean"] for key in target_keys}

    node_dim = 1 + 2 * len(NODE_NUMERIC_FEATURES)
    edge_dim = 2 * len(EDGE_NUMERIC_FEATURES)
    model = MessagePassingSurrogate(torch, node_dim, edge_dim, args.hidden, args.layers, target_keys).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate)
    loss_fn = torch.nn.SmoothL1Loss(reduction="none")

    train_graphs = [
        (to_graph_tensors(torch, sample, device, args.max_nodes), *target_vector(torch, sample, stats, target_keys, device))
        for sample in splits["train"]
    ]

    loss_history: list[dict[str, Any]] = []
    for epoch in range(args.epochs):
        model.train()
        epoch_loss = 0.0
        for graph, target, mask in train_graphs:
            optimizer.zero_grad(set_to_none=True)
            pred = model.forward(graph)
            loss = (loss_fn(pred, target) * mask).sum() / mask.sum().clamp(min=1.0)
            loss.backward()
            optimizer.step()
            epoch_loss += float(loss.item())
        mean_epoch_loss = epoch_loss / max(len(train_graphs), 1)
        if epoch == 0 or epoch == args.epochs - 1 or (epoch + 1) % 10 == 0:
            loss_history.append({"epoch": epoch + 1, "loss": round(mean_epoch_loss, 8)})

    evaluations = [
        evaluate(torch, model, splits[name], stats, target_keys, baseline, device, args.max_nodes, name)
        for name in ("train", "val", "test")
    ]

    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    model_path = out_dir / "gnn_model.pt"
    torch.save(
        {
            "model_state_dict": model.state_dict(),
            "node_feature_schema": ["cell_name_hash_unit"]
            + [item for key in NODE_NUMERIC_FEATURES for item in (key, f"{key}_present")],
            "edge_feature_schema": [item for key in EDGE_NUMERIC_FEATURES for item in (key, f"{key}_present")],
            "target_keys": target_keys,
            "target_normalization": stats,
            "hidden": args.hidden,
            "layers": args.layers,
            "claim_boundary": CLAIM_BOUNDARY,
        },
        model_path,
    )

    held_out_design_ids = {
        name: sorted({sample["design_id"] for sample in splits[name]}) for name in ("train", "val", "test")
    }

    metrics = {
        "schema": "eliza.ai_eda.pd_surrogates_metrics.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "device": device.type,
        "epochs": args.epochs,
        "model_type": "hand_rolled_message_passing_gnn",
        "target_keys": target_keys,
        "baseline_type": "train_split_mean",
        "splits": evaluations,
        "loss_history": loss_history,
        "release_use_allowed": False,
    }
    metrics_path = out_dir / "metrics.json"
    metrics_path.write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    report = {
        "schema": "eliza.ai_eda.pd_surrogates_training_run.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "device": device.type,
        "epochs": args.epochs,
        "model": rel(model_path),
        "metrics": rel(metrics_path),
        "model_type": "hand_rolled_message_passing_gnn",
        "message_passing_backend": "pure_torch_segment_sum_scatter_no_torch_geometric",
        "record_dirs": [rel(path) for path in record_dirs],
        "sample_count": len(samples),
        "split_policy": "deterministic_design_id_hash_80_10_10_no_case_leakage",
        "split_counts": {name: len(splits[name]) for name in ("train", "val", "test")},
        "held_out_design_ids": held_out_design_ids,
        "max_nodes": args.max_nodes,
        "truncated_sample_count": sum(1 for sample in samples if sample["truncated"]),
        "next_required_gates": [
            "scale converted CircuitNet3 corpus and preserve upstream split metadata",
            "train on CUDA (Nebius H200) after contamination and license review",
            "compare predictions only against local replayed E1 OpenLane/OpenROAD labels before any optimization claim",
        ],
        "release_use_allowed": False,
    }
    report_path = out_dir / "gnn_training_run.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(
        "STATUS: PASS ai_eda.pd_surrogates "
        f"device={device.type} train={len(splits['train'])} val={len(splits['val'])} "
        f"test={len(splits['test'])} targets={len(target_keys)} {rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
