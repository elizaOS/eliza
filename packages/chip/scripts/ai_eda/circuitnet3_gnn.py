#!/usr/bin/env python3
"""Heterogeneous message-passing GNN for CircuitNet 3.0 timing/power surrogates.

Pure-PyTorch implementation (no torch-geometric dependency) so it trains on a
CPU host. The model operates on the converted ``eda.graph_sample.v1`` records:
cell instances are nodes, ``net_fanout`` edges encode the structural driver->sink
topology recovered from the final netlist. Each relation (forward fanout and the
reverse direction) gets its own message transform, giving the network a
heterogeneous relational view of the netlist before a global readout predicts the
per-design timing/power summary targets.

This module is import-only (graph featurization + the ``CircuitNetGNN`` model).
``train_circuitnet3_gnn.py`` owns CLI, training loop, and artifact emission.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch
from torch import Tensor, nn

# Continuous design-level regression targets, matching the mean-baseline target
# set so the two models are directly comparable on the same held-out cases.
TARGETS: tuple[str, ...] = (
    "min_slack",
    "mean_slack",
    "max_at",
    "mean_delay",
    "mean_slew",
    "total_power",
)

# Per-node continuous features read from each ``node_features`` entry. Missing
# values are imputed to the train-set mean during standardization.
NODE_NUMERIC_FEATURES: tuple[str, ...] = (
    "drive_strength",
    "fanout_num",
    "fanout_res",
    "fanout_load_mean",
    "at",
    "slack",
    "setup_mean",
)

# Cell-family buckets derived from the standard-cell name prefix. Drives a learned
# embedding so the network can distinguish combinational gates, flops, buffers...
CELL_FAMILIES: tuple[str, ...] = (
    "NAND",
    "NOR",
    "AND",
    "OR",
    "XOR",
    "XNOR",
    "INV",
    "BUF",
    "MX",
    "DFF",
    "AOI",
    "OAI",
    "OTHER",
)
_FAMILY_INDEX = {name: idx for idx, name in enumerate(CELL_FAMILIES)}


def cell_family(cell_name: str) -> str:
    upper = cell_name.upper()
    # Order matters: check the more specific prefixes before the shorter ones.
    for family in ("XNOR", "NAND", "NOR", "AOI", "OAI", "XOR", "DFF", "INV", "BUF", "MX"):
        if upper.startswith(family):
            return family
    for family in ("AND", "OR"):
        if upper.startswith(family):
            return family
    return "OTHER"


@dataclass(frozen=True)
class GraphSample:
    """A single design's graph tensors plus its regression targets."""

    case_id: str
    design_bundle_id: str
    node_numeric: Tensor  # [num_nodes, len(NODE_NUMERIC_FEATURES)]
    node_family: Tensor  # [num_nodes] long
    edge_index: Tensor  # [2, num_edges] long (driver -> sink)
    targets: Tensor  # [len(TARGETS)] float
    target_mask: Tensor  # [len(TARGETS)] bool (label present)


def _finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    parsed = float(value)
    return parsed if math.isfinite(parsed) else None


def load_graph_sample(path: Path) -> GraphSample | None:
    record = json.loads(path.read_text(encoding="utf-8"))
    if record.get("schema") != "eda.graph_sample.v1":
        return None
    graph = record.get("graph", {})
    nodes = graph.get("node_features", [])
    if not isinstance(nodes, list) or not nodes:
        return None

    node_index: dict[str, int] = {}
    numeric_rows: list[list[float]] = []
    family_rows: list[int] = []
    for node in nodes:
        node_id = node.get("id")
        if not isinstance(node_id, str) or node_id in node_index:
            continue
        node_index[node_id] = len(numeric_rows)
        row = [_finite(node.get(feature)) for feature in NODE_NUMERIC_FEATURES]
        # NaN marks "missing" so standardization can impute to the column mean.
        numeric_rows.append([value if value is not None else math.nan for value in row])
        family_rows.append(_FAMILY_INDEX[cell_family(str(node.get("cell_name", "")))])

    edges = graph.get("edge_features", [])
    src_idx: list[int] = []
    dst_idx: list[int] = []
    for edge in edges if isinstance(edges, list) else ():
        if edge.get("edge_type") != "net_fanout":
            continue
        src, dst = edge.get("src"), edge.get("dst")
        if src in node_index and dst in node_index:
            src_idx.append(node_index[src])
            dst_idx.append(node_index[dst])

    label_values = record.get("labels", {}).get("values", {})
    target_list: list[float] = []
    mask_list: list[bool] = []
    for target in TARGETS:
        value = _finite(label_values.get(target))
        target_list.append(value if value is not None else 0.0)
        mask_list.append(value is not None)
    if not any(mask_list):
        return None

    edge_index = (
        torch.tensor([src_idx, dst_idx], dtype=torch.long)
        if src_idx
        else torch.zeros((2, 0), dtype=torch.long)
    )
    return GraphSample(
        case_id=str(record.get("id", path.stem)),
        design_bundle_id=str(record.get("design_bundle_id", "")),
        node_numeric=torch.tensor(numeric_rows, dtype=torch.float32),
        node_family=torch.tensor(family_rows, dtype=torch.long),
        edge_index=edge_index,
        targets=torch.tensor(target_list, dtype=torch.float32),
        target_mask=torch.tensor(mask_list, dtype=torch.bool),
    )


def load_graph_samples(record_dirs: list[Path]) -> list[GraphSample]:
    samples: list[GraphSample] = []
    seen: set[str] = set()
    for record_dir in record_dirs:
        if not record_dir.exists():
            continue
        for path in sorted(record_dir.glob("*graph-sample.json")):
            sample = load_graph_sample(path)
            if sample is None or sample.case_id in seen:
                continue
            seen.add(sample.case_id)
            samples.append(sample)
    return samples


@dataclass(frozen=True)
class FeatureStats:
    """Train-set standardization statistics for node + target tensors."""

    node_mean: Tensor
    node_std: Tensor
    target_mean: Tensor
    target_std: Tensor


def compute_feature_stats(samples: list[GraphSample]) -> FeatureStats:
    node_stack = torch.cat([sample.node_numeric for sample in samples], dim=0)
    node_mean = torch.nanmean(node_stack, dim=0)
    centered = node_stack - node_mean
    node_var = torch.nanmean(centered * centered, dim=0)
    node_std = torch.sqrt(node_var).clamp_min(1e-6)

    target_sum = torch.zeros(len(TARGETS))
    target_sq = torch.zeros(len(TARGETS))
    target_count = torch.zeros(len(TARGETS))
    for sample in samples:
        mask = sample.target_mask.float()
        target_sum += sample.targets * mask
        target_sq += (sample.targets * sample.targets) * mask
        target_count += mask
    target_count = target_count.clamp_min(1.0)
    target_mean = target_sum / target_count
    target_var = (target_sq / target_count) - target_mean * target_mean
    target_std = torch.sqrt(target_var.clamp_min(0.0)).clamp_min(1e-6)
    return FeatureStats(node_mean, node_std, target_mean, target_std)


def standardize_nodes(sample: GraphSample, stats: FeatureStats) -> Tensor:
    raw = sample.node_numeric
    # Impute missing entries to the column mean (==0 after standardization).
    imputed = torch.where(torch.isnan(raw), stats.node_mean, raw)
    return (imputed - stats.node_mean) / stats.node_std


class RelationalConv(nn.Module):
    """Two-relation mean-aggregation message passing (forward + reverse fanout)."""

    def __init__(self, in_dim: int, out_dim: int) -> None:
        super().__init__()
        self.self_lin = nn.Linear(in_dim, out_dim)
        self.fwd_lin = nn.Linear(in_dim, out_dim)
        self.rev_lin = nn.Linear(in_dim, out_dim)

    def forward(self, x: Tensor, edge_index: Tensor) -> Tensor:
        out = self.self_lin(x)
        if edge_index.numel() > 0:
            src, dst = edge_index[0], edge_index[1]
            out = out + _scatter_mean(self.fwd_lin(x).index_select(0, src), dst, x.size(0))
            out = out + _scatter_mean(self.rev_lin(x).index_select(0, dst), src, x.size(0))
        return out


def _scatter_mean(messages: Tensor, index: Tensor, num_nodes: int) -> Tensor:
    out = torch.zeros(num_nodes, messages.size(1), dtype=messages.dtype)
    out.index_add_(0, index, messages)
    counts = torch.zeros(num_nodes, dtype=messages.dtype)
    counts.index_add_(0, index, torch.ones(index.size(0), dtype=messages.dtype))
    return out / counts.clamp_min(1.0).unsqueeze(1)


class CircuitNetGNN(nn.Module):
    """Heterogeneous netlist GNN with global readout for design-level regression."""

    def __init__(
        self,
        num_numeric: int = len(NODE_NUMERIC_FEATURES),
        num_families: int = len(CELL_FAMILIES),
        num_targets: int = len(TARGETS),
        hidden_dim: int = 64,
        family_dim: int = 8,
        num_layers: int = 3,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        self.family_embedding = nn.Embedding(num_families, family_dim)
        self.input_proj = nn.Linear(num_numeric + family_dim, hidden_dim)
        self.convs = nn.ModuleList(
            RelationalConv(hidden_dim, hidden_dim) for _ in range(num_layers)
        )
        self.norms = nn.ModuleList(nn.LayerNorm(hidden_dim) for _ in range(num_layers))
        self.dropout = nn.Dropout(dropout)
        self.readout = nn.Sequential(
            nn.Linear(hidden_dim * 2, hidden_dim),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, num_targets),
        )

    def forward(self, node_numeric: Tensor, node_family: Tensor, edge_index: Tensor) -> Tensor:
        x = torch.cat([node_numeric, self.family_embedding(node_family)], dim=1)
        x = torch.relu(self.input_proj(x))
        for conv, norm in zip(self.convs, self.norms, strict=True):
            residual = x
            x = torch.relu(norm(conv(x, edge_index)))
            x = self.dropout(x) + residual
        pooled = torch.cat([x.mean(dim=0), x.amax(dim=0)], dim=0)
        return self.readout(pooled)
