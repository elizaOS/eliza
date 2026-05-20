"""Thin driver that runs the upstream scale-sim-v2 v3.0.0 simulator over our
elizanpu NPU topology and returns its compute/bandwidth report items in a form
that fits the ``eliza.npu_scale_sim.v1`` evidence schema as a sidecar block.

Upstream simulator is vendored at ``external/scale-sim-v2`` and pinned to tag
``v3.0.0`` (commit ``7fd972e``) via ``external/scale-sim-v2/pin-manifest.json``.

The v3 driver exists alongside the hand-rolled v1 model in
``compiler/runtime/e1_npu_scale_model.py``. The hand-rolled model is the source
of truth for evidence numbers; v3 numbers ride along as an external,
independently produced sanity-check feed so we can audit drift later.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

try:
    from scalesim.scale_sim import scalesim

    SCALESIM_V3_AVAILABLE = True
    SCALESIM_V3_UNAVAILABLE_REASON: str | None = None
except ImportError as exc:  # pragma: no cover - exercised only when uninstalled
    scalesim = None
    SCALESIM_V3_AVAILABLE = False
    SCALESIM_V3_UNAVAILABLE_REASON = (
        "scalesim package not importable; install external/scale-sim-v2 via "
        f"`pip install -e external/scale-sim-v2/` (ImportError: {exc})"
    )


# Header line copied verbatim from upstream layouts so the parser accepts our
# generated layout. Twenty per-layer columns follow, in order.
_LAYOUT_HEADER = (
    "Layer name, IFMAP Height Intraline Factor, IFMAP Width Intraline Factor, "
    "Filter Height Intraline Factor, Filter Width Intraline Factor, "
    "Channel Intraline Factor, Num Filter Intraline Factor, "
    "IFMAP Height Intraline Order, IFMAP Width Intraline Order, "
    "Channel Intraline Order, IFMAP Height Interline Order, "
    "IFMAP Width Interline Order, Channel Interline Order, "
    "Num Filter Intraline Order, Channel Intraline Order, "
    "Filter Height Intraline Order, Filter Width Intraline Order, "
    "Num Filter Interline Order, Channel Interline Order, "
    "Filter Height Interline Order, Filter Width Interline Order, "
)

# Order columns used in the upstream conv_nets/test.csv layout. Picked because
# upstream ships them in their default tests and they parse cleanly through
# scalesim's layout_utils parser.
_LAYOUT_ORDER_COLUMNS = "1,2,0,4,5,3,3,0,1,2,7,4,5,6,"


def _arch_cfg_text(
    *,
    run_name: str,
    array_h: int,
    array_w: int,
    ifmap_sram_kb: int,
    filter_sram_kb: int,
    ofmap_sram_kb: int,
    bandwidth_words_per_cycle: int,
    dataflow: str,
    sparsity_support: bool,
) -> str:
    """Render an upstream-format ``arch.cfg`` for a single run."""

    sparsity_flag = "true" if sparsity_support else "false"
    return f"""[general]
run_name = {run_name}

[architecture_presets]
ArrayHeight:    {array_h}
ArrayWidth:     {array_w}
IfmapSramSzkB:  {ifmap_sram_kb}
FilterSramSzkB: {filter_sram_kb}
OfmapSramSzkB:  {ofmap_sram_kb}
IfmapOffset:    0
FilterOffset:   10000000
OfmapOffset:    20000000
Bandwidth : {bandwidth_words_per_cycle}
Dataflow : {dataflow}
MemoryBanks:   1
ReadRequestBuffer: 32
WriteRequestBuffer: 32

[layout]
IfmapCustomLayout: False
IfmapSRAMBankBandwidth: {bandwidth_words_per_cycle}
IfmapSRAMBankNum: 10
IfmapSRAMBankPort: 2
FilterCustomLayout: False
FilterSRAMBankBandwidth: {bandwidth_words_per_cycle}
FilterSRAMBankNum: 10
FilterSRAMBankPort: 2

[sparsity]
SparsitySupport : {sparsity_flag}
SparseRep : ellpack_block
OptimizedMapping : false
BlockSize : 8
RandomNumberGeneratorSeed : 40

[run_presets]
InterfaceBandwidth: CALC
UseRamulatorTrace: False
"""


@dataclass(frozen=True)
class GemmShape:
    """A single GEMM layer mapped onto upstream's M/N/K topology format."""

    name: str
    m: int
    n: int
    k: int


@dataclass(frozen=True)
class ScalesimV3LayerReport:
    """Per-layer compute + bandwidth report returned from upstream."""

    name: str
    overall_cycles: int
    total_cycles: int
    stall_cycles: int
    overall_util_percent: float
    mapping_eff_percent: float
    compute_util_percent: float
    avg_ifmap_sram_bw_words_per_cycle: float
    avg_filter_sram_bw_words_per_cycle: float
    avg_ofmap_sram_bw_words_per_cycle: float
    avg_ifmap_dram_bw_words_per_cycle: float
    avg_filter_dram_bw_words_per_cycle: float
    avg_ofmap_dram_bw_words_per_cycle: float


@dataclass(frozen=True)
class ScalesimV3Result:
    """Aggregate scalesim-v3 run output."""

    engine: str
    upstream_tag: str
    upstream_commit: str
    array_height: int
    array_width: int
    dataflow: str
    sparsity_support: bool
    layers: tuple[ScalesimV3LayerReport, ...]
    sum_total_cycles: int
    sum_stall_cycles: int


def run_scalesim_v3_workload(
    shapes: Sequence[GemmShape],
    *,
    array_h: int,
    array_w: int,
    ifmap_sram_kb: int = 64,
    filter_sram_kb: int = 64,
    ofmap_sram_kb: int = 64,
    bandwidth_words_per_cycle: int = 10,
    dataflow: str = "ws",
    sparsity_support: bool = False,
    run_name: str = "elizanpu_gemm_s8",
) -> ScalesimV3Result:
    """Drive upstream scalesim v3.0.0 over the supplied GEMM shapes.

    The systolic array is configured to match elizanpu.gemm_s8 (default
    ``array_h = array_w = 3``). The layout file uses ``Intraline Factor`` = 1
    everywhere so all dimensions are interline; this is the simplest mapping
    that lets upstream's layout parser accept arbitrary M/N/K shapes.
    """

    if not SCALESIM_V3_AVAILABLE:
        raise RuntimeError(SCALESIM_V3_UNAVAILABLE_REASON)
    if not shapes:
        raise ValueError("shapes must contain at least one GEMM layer")

    cfg_text = _arch_cfg_text(
        run_name=run_name,
        array_h=array_h,
        array_w=array_w,
        ifmap_sram_kb=ifmap_sram_kb,
        filter_sram_kb=filter_sram_kb,
        ofmap_sram_kb=ofmap_sram_kb,
        bandwidth_words_per_cycle=bandwidth_words_per_cycle,
        dataflow=dataflow,
        sparsity_support=sparsity_support,
    )

    topo_lines = ["Layer,M,N,K,"]
    layout_lines = [_LAYOUT_HEADER]
    for shape in shapes:
        topo_lines.append(f"{shape.name},{shape.m},{shape.n},{shape.k},")
        layout_lines.append(f"{shape.name},1,1,1,1,1,1,{_LAYOUT_ORDER_COLUMNS}")

    with tempfile.TemporaryDirectory(prefix="scalesim_v3_") as tmp:
        tmp_path = Path(tmp)
        cfg_path = tmp_path / "arch.cfg"
        cfg_path.write_text(cfg_text)
        topo_path = tmp_path / "topology.csv"
        topo_path.write_text("\n".join(topo_lines) + "\n")
        layout_path = tmp_path / "layout.csv"
        layout_path.write_text("\n".join(layout_lines) + "\n")

        # Upstream prints progress bars / banners; silence them so JSON-only
        # consumers (the make gate, pipelines) get clean stdout.
        original_stdout_fd = os.dup(1)
        original_stderr_fd = os.dup(2)
        devnull_fd = os.open(os.devnull, os.O_WRONLY)
        try:
            os.dup2(devnull_fd, 1)
            os.dup2(devnull_fd, 2)
            sim = scalesim(
                save_disk_space=True,
                verbose=False,
                config=str(cfg_path),
                topology=str(topo_path),
                layout=str(layout_path),
                input_type_gemm=True,
            )
            sim.run_scale(top_path=str(tmp_path))
        finally:
            os.dup2(original_stdout_fd, 1)
            os.dup2(original_stderr_fd, 2)
            os.close(original_stdout_fd)
            os.close(original_stderr_fd)
            os.close(devnull_fd)

        reports: list[ScalesimV3LayerReport] = []
        for shape, layer in zip(shapes, sim.runner.single_layer_sim_object_list, strict=True):
            compute = layer.get_compute_report_items()
            bandwidth = layer.get_bandwidth_report_items()
            reports.append(
                ScalesimV3LayerReport(
                    name=shape.name,
                    overall_cycles=int(compute[0]),
                    total_cycles=int(compute[1]),
                    stall_cycles=int(compute[2]),
                    overall_util_percent=float(compute[3]),
                    mapping_eff_percent=float(compute[4]),
                    compute_util_percent=float(compute[5]),
                    avg_ifmap_sram_bw_words_per_cycle=float(bandwidth[0]),
                    avg_filter_sram_bw_words_per_cycle=float(bandwidth[1]),
                    avg_ofmap_sram_bw_words_per_cycle=float(bandwidth[2]),
                    avg_ifmap_dram_bw_words_per_cycle=float(bandwidth[3]),
                    avg_filter_dram_bw_words_per_cycle=float(bandwidth[4]),
                    avg_ofmap_dram_bw_words_per_cycle=float(bandwidth[5]),
                )
            )

    return ScalesimV3Result(
        engine="scalesim-v3",
        upstream_tag="v3.0.0",
        upstream_commit="7fd972e7c650e81c77294c9433143a282235c5e7",
        array_height=array_h,
        array_width=array_w,
        dataflow=dataflow,
        sparsity_support=sparsity_support,
        layers=tuple(reports),
        sum_total_cycles=sum(layer.total_cycles for layer in reports),
        sum_stall_cycles=sum(layer.stall_cycles for layer in reports),
    )


def result_to_evidence_block(result: ScalesimV3Result) -> dict[str, object]:
    """Serialize a ``ScalesimV3Result`` into the JSON-safe sidecar block."""

    return {
        "schema": "eliza.npu_scale_sim.scalesim_v3.v1",
        "claim_boundary": (
            "Upstream scalesim v3.0.0 driven through its python API over the "
            "elizanpu.gemm_s8 systolic shape; not measured RTL, NNAPI, or "
            "silicon evidence. Sidecar feed only; v1 hand-rolled model remains "
            "the source of truth for the eliza.npu_scale_sim.v1 schema."
        ),
        "engine": result.engine,
        "upstream_tag": result.upstream_tag,
        "upstream_commit": result.upstream_commit,
        "array_height": result.array_height,
        "array_width": result.array_width,
        "dataflow": result.dataflow,
        "sparsity_support": result.sparsity_support,
        "sum_total_cycles": result.sum_total_cycles,
        "sum_stall_cycles": result.sum_stall_cycles,
        "layers": [
            {
                "name": layer.name,
                "overall_cycles": layer.overall_cycles,
                "total_cycles": layer.total_cycles,
                "stall_cycles": layer.stall_cycles,
                "overall_util_percent": layer.overall_util_percent,
                "mapping_eff_percent": layer.mapping_eff_percent,
                "compute_util_percent": layer.compute_util_percent,
                "avg_ifmap_sram_bw_words_per_cycle": layer.avg_ifmap_sram_bw_words_per_cycle,
                "avg_filter_sram_bw_words_per_cycle": layer.avg_filter_sram_bw_words_per_cycle,
                "avg_ofmap_sram_bw_words_per_cycle": layer.avg_ofmap_sram_bw_words_per_cycle,
                "avg_ifmap_dram_bw_words_per_cycle": layer.avg_ifmap_dram_bw_words_per_cycle,
                "avg_filter_dram_bw_words_per_cycle": layer.avg_filter_dram_bw_words_per_cycle,
                "avg_ofmap_dram_bw_words_per_cycle": layer.avg_ofmap_dram_bw_words_per_cycle,
            }
            for layer in result.layers
        ],
    }
