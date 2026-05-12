"""End-to-end Eliza-1 optimization -> GGUF -> HF push pipeline.

Composes the per-technique apply scripts in dependency order, runs the
``elizaOS/llama.cpp`` GGUF conversion (fork-aware, understands the new
GGML types ``Q4_POLAR=47`` and ``QJL1_256=46``), and publishes a
single ``elizaos/eliza-1-<tier>`` HuggingFace repo whose contents are
ready for the on-device Eliza-1 downloader to consume.

The orchestrator is **idempotent**: each step writes its sidecar
artifact (``polarquant_artifacts.safetensors``,
``qjl_config.json``, ``turboquant.json``, …) and the final GGUF +
``eliza1_manifest.json`` declares the full applied stack so phones can
load the file without re-deriving anything at runtime.

Usage::

    # Dry-run on the smallest Eliza-1 tier.
    uv run python scripts/optimize_for_eliza1.py \\
        --base-model elizaos/eliza-1-0_6b \\
        --output-dir checkpoints/eliza-1-0_6b \\
        --apply polarquant qjl turboquant \\
        --gguf-target packages/inference \\
        --hf-repo elizaos/eliza-1-0_6b \\
        --dry-run

    # Real run (needs the elizaOS/llama.cpp v1.0.0-eliza checkout
    # at $LLAMA_CPP_DIR for the convert step + a real HF token).
    HF_TOKEN=hf_xxx LLAMA_CPP_DIR=$HOME/src/milady-llama.cpp \\
        uv run python scripts/optimize_for_eliza1.py \\
            --base-model elizaos/eliza-1-0_6b \\
            --output-dir checkpoints/eliza-1-0_6b \\
            --apply polarquant qjl turboquant \\
            --hf-repo elizaos/eliza-1-0_6b

The downstream ``llama-server`` invocation that the published manifest
documents looks like::

    llama-server --model eliza-1-0_6b-Q4_POLAR.gguf \\
                 --draft-model eliza-1-0_6b-drafter.gguf \\
                 --spec-type dflash \\
                 --cache-type-k qjl1_256 \\
                 --cache-type-v tbq3_0

Hardware notes:
  - PolarQuant is data-free, pure CPU. Runs on this Linux x86_64 host with
    no GPU.
  - QJL apply needs a small calibration sweep but the Python reference
    path is CPU-runnable for tiny models (the CUDA kernel build under
    ``qjl/csrc/`` is for *inference*, not for apply).
  - TurboQuant calibration requires a CUDA device for the
    ``fused_turboquant_apply`` Triton path. The orchestrator falls back to
    the pure-PyTorch ``turboquant_apply`` automatically when no GPU is
    present (production runs of fused-turboquant should target a GPU
    runner).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("optimize_for_eliza1")


# Ordered application sequence. PolarQuant rewrites weights in place and
# emits the int8 codes sidecar — must run first so the saved checkpoint
# carries the reconstructed fp16 weights and the codes payload that the
# fork's ``Q4_POLAR`` GGML type packs at convert time. QJL + TurboQuant
# write JSON sidecars only (``qjl_config.json`` / ``turboquant.json``)
# and don't mutate weights, so they can run in any order after PolarQuant
# but must run before GGUF conversion (the sidecars feed the GGUF metadata
# block describing K and V cache projection geometry).
APPLY_ORDER = ("polarquant", "qjl", "turboquant")


@dataclass(frozen=True)
class StageResult:
    """Outcome of one apply stage."""

    name: str
    exit_code: int
    output_dir: Path
    duration_s: float
    sidecar_path: Path | None = None
    skipped: bool = False
    skip_reason: str = ""


@dataclass(frozen=True)
class OptimizationPlan:
    """Resolved orchestration plan, captured before execution."""

    base_model: str
    output_dir: Path
    apply: tuple[str, ...]
    calibration: Path | None
    calibration_samples: int
    gguf_target: Path | None
    llama_cpp_dir: Path | None
    hf_repo: str | None
    drafter_repo: str | None
    dry_run: bool
    has_cuda: bool
    extra_apply_args: dict[str, list[str]] = field(default_factory=dict)


def _detect_cuda() -> bool:
    try:
        import torch  # type: ignore[import-not-found]
    except ImportError:
        return False
    return bool(torch.cuda.is_available())


def _resolve_apply_script(name: str) -> Path:
    """Map an apply name to its CLI entry script.

    PolarQuant + QJL each have a single ``<name>_apply.py``; TurboQuant
    has both pure-PyTorch (``turboquant_apply.py``) and Triton
    (``fused_turboquant_apply.py``); the orchestrator picks based on CUDA
    availability + an explicit override.
    """
    quant_dir = ROOT / "scripts" / "quantization"
    candidates = {
        "polarquant": quant_dir / "polarquant_apply.py",
        "qjl": quant_dir / "qjl_apply.py",
        "turboquant": quant_dir / "turboquant_apply.py",
        "fused_turboquant": quant_dir / "fused_turboquant_apply.py",
        "abliteration": quant_dir / "abliteration_apply.py",
    }
    if name not in candidates:
        raise SystemExit(
            f"unknown apply name {name!r}; valid: {sorted(candidates)}"
        )
    p = candidates[name]
    if not p.exists():
        raise SystemExit(f"apply script not on disk: {p}")
    return p


def _stage_output_dir(root: Path, stage: str) -> Path:
    return root / f"stage-{stage}"


def _select_input_for_stage(
    plan: OptimizationPlan, stage: str, prior: list[StageResult]
) -> str:
    """Decide what ``--model`` value to feed the next stage.

    PolarQuant runs first and reads the base model; later stages read
    the PolarQuant output (which is a regular HF checkpoint dir + the
    PolarQuant codes sidecar) so they walk the same weights.
    """
    for prev in prior:
        if not prev.skipped and prev.exit_code == 0:
            return str(prev.output_dir)
    return plan.base_model


def _run(cmd: list[str], *, dry_run: bool) -> int:
    log.info("$ %s", " ".join(cmd))
    if dry_run:
        return 0
    t0 = time.perf_counter()
    rc = subprocess.run(cmd, check=False).returncode
    log.info("  → exit=%d (%.1fs)", rc, time.perf_counter() - t0)
    return rc


def _run_apply_stage(
    plan: OptimizationPlan,
    stage: str,
    prior: list[StageResult],
) -> StageResult:
    out_dir = _stage_output_dir(plan.output_dir, stage)
    sidecar_filename = {
        "polarquant": "polarquant_artifacts.safetensors",
        "qjl": "qjl_config.json",
        "turboquant": "turboquant.json",
        "fused_turboquant": "turboquant.json",
    }.get(stage)

    # Skip TurboQuant on CPU-only — Triton + the pure-PyTorch path both
    # need CUDA when calibrating and importing turbokv. We document the
    # skip in the manifest so the consumer knows the V-cache config is
    # the framework default rather than a calibrated profile.
    if stage in ("turboquant", "fused_turboquant") and not plan.has_cuda:
        log.warning(
            "stage %s requires CUDA; running in skip mode (manifest will "
            "fall back to default tbq3_0 V-cache config)",
            stage,
        )
        return StageResult(
            name=stage,
            exit_code=0,
            output_dir=out_dir,
            duration_s=0.0,
            sidecar_path=None,
            skipped=True,
            skip_reason="CUDA unavailable; using upstream defaults",
        )

    apply_script = _resolve_apply_script(stage)
    input_model = _select_input_for_stage(plan, stage, prior)

    cmd: list[str] = [
        sys.executable,
        str(apply_script),
        "--model",
        input_model,
        "--output",
        str(out_dir),
    ]
    if plan.calibration is not None:
        cmd += ["--calibration", str(plan.calibration)]
    if plan.calibration_samples:
        cmd += ["--calibration-samples", str(plan.calibration_samples)]

    # The QJL + TurboQuant scripts default to ``--device cuda`` and
    # raise on a CPU box. Force ``--device cpu`` when CUDA isn't
    # available so the dry-run path here mirrors the production CPU-only
    # smoke target.
    if stage in ("qjl", "turboquant", "fused_turboquant") and not plan.has_cuda:
        cmd += ["--device", "cpu"]

    cmd += plan.extra_apply_args.get(stage, [])

    if plan.dry_run:
        cmd += ["--dry-run"]

    t0 = time.perf_counter()
    rc = _run(cmd, dry_run=False)  # always exec — apply scripts honour --dry-run themselves
    duration = time.perf_counter() - t0

    sidecar_path: Path | None = None
    if sidecar_filename and not plan.dry_run:
        candidate = out_dir / sidecar_filename
        if candidate.exists():
            sidecar_path = candidate

    return StageResult(
        name=stage,
        exit_code=rc,
        output_dir=out_dir,
        duration_s=duration,
        sidecar_path=sidecar_path,
    )


def _build_eliza1_manifest(
    plan: OptimizationPlan,
    stages: list[StageResult],
    gguf_target_path: Path,
    drafter_path: Path | None,
) -> dict[str, object]:
    """Produce the runtime manifest written next to the GGUF.

    Phones consume this via the existing downloader; the Eliza-1-side
    catalog (``packages/shared/src/local-inference/catalog.ts``, emitted
    via ``scripts/emit_eliza1_catalog.py``) points at the published HF
    repo and keys off the manifest's ``runtime`` block to set
    ``llama-server`` flags.
    """
    applied: dict[str, dict[str, object]] = {}
    for s in stages:
        block: dict[str, object] = {
            "applied": not s.skipped,
            "exit_code": s.exit_code,
            "duration_s": round(s.duration_s, 2),
        }
        if s.skipped:
            block["skipped"] = True
            block["reason"] = s.skip_reason
        if s.sidecar_path is not None:
            block["sidecar"] = s.sidecar_path.name
        applied[s.name] = block

    return {
        "schema_version": 1,
        "produced_by": "scripts/optimize_for_eliza1.py",
        "produced_at_unix": int(time.time()),
        "base_model": plan.base_model,
        "target_repo": plan.hf_repo,
        "drafter_repo": plan.drafter_repo,
        "applied": applied,
        "gguf": {
            "filename": gguf_target_path.name,
            "ggml_types": {
                # Per docs/porting/unified-fork-strategy.md §B and the
                # compile-libllama.mjs preamble.
                "weights": "Q4_POLAR=47",
                "k_cache": "QJL1_256=46",
                "v_cache": "TBQ3_0=43",
            },
            "drafter_filename": drafter_path.name if drafter_path else None,
        },
        "runtime": {
            # The exact llama-server invocation phones run. Manifest is
            # intentionally a flat command shape — no Eliza-1-side string
            # composition, the downloader can quote and execute as-is.
            "binary": "llama-server",
            "args": [
                "--model",
                gguf_target_path.name,
                *(
                    ["--draft-model", drafter_path.name]
                    if drafter_path is not None
                    else []
                ),
                "--spec-type",
                "dflash",
                "--cache-type-k",
                "qjl1_256",
                "--cache-type-v",
                "tbq3_0",
            ],
            "min_llama_cpp_tag": "v1.0.0-eliza",
            "min_llama_cpp_commit": "08032d57e15574f2a7ca19fc3f29510c8673d590",
            "fork_remote": "https://github.com/elizaOS/llama.cpp.git",
        },
    }


def _emit_load_readme(manifest: dict[str, object]) -> str:
    """Construct the README.md content shipped to the published HF repo.

    Documents the load command, the GGML types in the file, and the
    minimum llama.cpp pin needed to consume them.
    """
    runtime = manifest["runtime"]  # type: ignore[index]
    args = runtime["args"]  # type: ignore[index]
    # Group flag/value pairs on the same line so the rendered command
    # is a real, copy-pasteable bash invocation.
    pairs: list[str] = []
    i = 0
    while i < len(args):  # type: ignore[arg-type]
        a = str(args[i])
        if a.startswith("--") and i + 1 < len(args) and not str(args[i + 1]).startswith("--"):
            pairs.append(f"{a} {args[i + 1]}")
            i += 2
        else:
            pairs.append(a)
            i += 1
    cmd = (
        str(runtime["binary"])  # type: ignore[index]
        + (" \\\n  " + " \\\n  ".join(pairs) if pairs else "")
    )
    gguf = manifest["gguf"]  # type: ignore[index]
    types = gguf["ggml_types"]  # type: ignore[index]
    return (
        "---\n"
        "library_name: llama.cpp\n"
        "tags:\n"
        "  - eliza1\n"
        "  - gguf\n"
        "  - polarquant\n"
        "  - qjl\n"
        "  - turboquant\n"
        "  - dflash\n"
        "---\n"
        "\n"
        "# Eliza-1-optimized GGUF\n"
        "\n"
        f"Base model: `{manifest['base_model']}`  \n"
        f"Produced by: `{manifest['produced_by']}`  \n"
        f"GGUF tensor file: `{gguf['filename']}`  \n"
        "\n"
        "## Applied optimizations\n"
        "\n"
        "| step | applied | sidecar |\n"
        "|---|---|---|\n"
        + "".join(
            f"| {name} | {block['applied']} | {block.get('sidecar', '—')} |\n"
            for name, block in manifest["applied"].items()  # type: ignore[index]
        )
        + "\n"
        "## GGML types in this file\n"
        "\n"
        f"- Weights: `{types['weights']}` (PolarQuant 4-bit)\n"
        f"- K cache: `{types['k_cache']}` (QJL 1-bit JL projection)\n"
        f"- V cache: `{types['v_cache']}` (TurboQuant 3-bit)\n"
        "\n"
        "These types only exist in `elizaOS/llama.cpp` "
        f"`>= {runtime['min_llama_cpp_tag']}` "
        f"(commit `{runtime['min_llama_cpp_commit']}`); the upstream "
        "`ggml-org/llama.cpp` build will refuse to load this file.\n"
        "\n"
        "## Load command\n"
        "\n"
        "```bash\n"
        f"{cmd}\n"
        "```\n"
        "\n"
        "DFlash speculative decoding is enabled when a `--draft-model` is set; the\n"
        "drafter must be an Eliza-1 GGUF with the same tokenizer family as the\n"
        "target (see "
        "`docs/porting/dflash-drafter-strategy.md`).\n"
    )


def _resolve_convert_script(llama_cpp_dir: Path | None) -> Path:
    """Find ``convert_hf_to_gguf.py`` inside the elizaOS/llama.cpp checkout."""
    if llama_cpp_dir is not None:
        cand = llama_cpp_dir / "convert_hf_to_gguf.py"
        if cand.exists():
            return cand
    env_dir = os.environ.get("LLAMA_CPP_DIR")
    if env_dir:
        cand = Path(env_dir) / "convert_hf_to_gguf.py"
        if cand.exists():
            return cand
    which = shutil.which("convert_hf_to_gguf.py")
    if which:
        return Path(which)
    raise FileNotFoundError(
        "convert_hf_to_gguf.py not found. Either pass --llama-cpp-dir or set "
        "LLAMA_CPP_DIR=$HOME/src/milady-llama.cpp (the elizaOS/llama.cpp "
        "v1.0.0-eliza checkout)."
    )


def _stage_dir(stages: list[StageResult], name: str) -> Path | None:
    for s in stages:
        if s.name == name and not s.skipped and s.exit_code == 0:
            return s.output_dir
    return None


def _convert_to_gguf(
    plan: OptimizationPlan,
    stages: list[StageResult],
    last_stage: StageResult,
    out_path: Path,
) -> int:
    """Emit the Eliza-1-typed GGUF by delegating to ``gguf_eliza1_apply.py``.

    That wrapper requests ``--outtype q4_polar`` (the fork's PolarQuant 4-bit
    GGML type) and, when the fork's ``convert_hf_to_gguf.py`` does not yet emit
    it, falls back to ``q8_0`` while recording the deferral + the PolarQuant
    codebook path in ``<gguf>.eliza1.json`` instead of crashing. K/V cache
    geometry (qjl1_256 K, tbq3_0 V) is per-context and set at ``llama-server``
    invocation time, not in the file — we still record it in the manifest so
    the downloader can construct the correct CLI.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    polar_dir = _stage_dir(stages, "polarquant")
    qjl_dir = _stage_dir(stages, "qjl")
    tbq_dir = _stage_dir(stages, "turboquant")
    apply_script = Path(__file__).resolve().parent / "quantization" / "gguf_eliza1_apply.py"
    cmd = [
        sys.executable, str(apply_script),
        "--checkpoint", str(last_stage.output_dir),
        "--output", str(out_path),
        "--outtype", "q4_polar",
    ]
    if plan.llama_cpp_dir is not None:
        cmd += ["--llama-cpp-dir", str(plan.llama_cpp_dir)]
    if polar_dir is not None:
        cmd += ["--polarquant-sidecar", str(polar_dir / "polarquant_config.json")]
    if qjl_dir is not None:
        cmd += ["--qjl-sidecar", str(qjl_dir / "qjl_config.json")]
    if tbq_dir is not None:
        cmd += ["--turboquant-sidecar", str(tbq_dir / "turboquant.json")]
    if plan.dry_run:
        cmd.append("--dry-run")
    return _run(cmd, dry_run=False)


def _push_to_hf(
    plan: OptimizationPlan,
    gguf_path: Path,
    manifest_path: Path,
    readme_path: Path,
) -> int:
    """Drive ``push_model_to_hf.py --eliza1-manifest`` to publish.

    We surface the new ``--eliza1-manifest`` flag added in this change
    so ``push_model_to_hf.py`` writes the manifest + README + GGUF as a
    single coherent upload set.
    """
    push_script = ROOT / "scripts" / "push_model_to_hf.py"
    if not push_script.exists():
        raise SystemExit(f"push_model_to_hf.py not found: {push_script}")
    cmd = [
        sys.executable,
        str(push_script),
        "--registry-key",
        "qwen3-0.6b",  # smoke entry; --repo-id below overrides anyway
        "--checkpoint",
        str(gguf_path.parent),
        "--repo-id",
        plan.hf_repo or "",
        "--eliza1-manifest",
        str(manifest_path),
        "--public",
    ]
    if plan.dry_run:
        cmd += ["--dry-run"]
    return _run(cmd, dry_run=False)


def execute_plan(plan: OptimizationPlan) -> int:
    """Run the full apply → GGUF → manifest → push pipeline."""
    plan.output_dir.mkdir(parents=True, exist_ok=True)

    stages: list[StageResult] = []
    for stage in plan.apply:
        if stage not in APPLY_ORDER:
            raise SystemExit(
                f"unknown apply step {stage!r}; valid: {APPLY_ORDER}"
            )
        result = _run_apply_stage(plan, stage, stages)
        stages.append(result)
        if result.exit_code != 0 and not result.skipped:
            log.error(
                "stage %s failed with exit=%d; aborting", stage, result.exit_code
            )
            (plan.output_dir / "pipeline-status.json").write_text(
                json.dumps(
                    {
                        "ok": False,
                        "failed_stage": stage,
                        "stages": [
                            {
                                "name": s.name,
                                "exit_code": s.exit_code,
                                "skipped": s.skipped,
                            }
                            for s in stages
                        ],
                    },
                    indent=2,
                ),
            )
            return result.exit_code

    # Last successful stage is the input to the GGUF conversion. If
    # nothing succeeded (all skipped), feed the base model directly.
    last_real_stage: StageResult | None = next(
        (s for s in reversed(stages) if not s.skipped and s.exit_code == 0),
        None,
    )
    convert_input = last_real_stage or StageResult(
        name="base",
        exit_code=0,
        output_dir=Path(plan.base_model),
        duration_s=0.0,
        sidecar_path=None,
        skipped=False,
    )

    base_slug = (
        plan.base_model.rstrip("/").split("/")[-1].replace(".", "-").lower()
    )
    gguf_filename = f"{base_slug}-Q4_POLAR.gguf"
    gguf_dir = plan.output_dir / "gguf"
    gguf_path = gguf_dir / gguf_filename

    rc = _convert_to_gguf(plan, stages, convert_input, gguf_path)
    if rc != 0:
        log.error("GGUF conversion failed (exit=%d)", rc)
        return rc

    manifest = _build_eliza1_manifest(plan, stages, gguf_path, None)
    manifest_path = gguf_dir / "eliza1_manifest.json"
    if not plan.dry_run:
        gguf_dir.mkdir(parents=True, exist_ok=True)
    if plan.dry_run:
        log.info(
            "(dry-run) would write manifest to %s\n%s",
            manifest_path,
            json.dumps(manifest, indent=2),
        )
    else:
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    readme_path = gguf_dir / "README.md"
    readme = _emit_load_readme(manifest)
    if plan.dry_run:
        log.info("(dry-run) would write README to %s", readme_path)
    else:
        readme_path.write_text(readme, encoding="utf-8")

    if plan.hf_repo:
        if plan.dry_run and not manifest_path.exists():
            log.info(
                "(dry-run) would push to %s with manifest %s",
                plan.hf_repo,
                manifest_path,
            )
        else:
            rc = _push_to_hf(plan, gguf_path, manifest_path, readme_path)
            if rc != 0:
                log.error("HF push failed (exit=%d)", rc)
                return rc

    summary = {
        "ok": True,
        "base_model": plan.base_model,
        "output_dir": str(plan.output_dir),
        "applied": list(plan.apply),
        "stages": [
            {
                "name": s.name,
                "exit_code": s.exit_code,
                "duration_s": round(s.duration_s, 2),
                "skipped": s.skipped,
                "skip_reason": s.skip_reason,
                "sidecar": str(s.sidecar_path) if s.sidecar_path else None,
            }
            for s in stages
        ],
        "gguf": str(gguf_path),
        "manifest": str(manifest_path),
        "readme": str(readme_path),
        "hf_repo": plan.hf_repo,
        "dry_run": plan.dry_run,
    }
    (plan.output_dir / "pipeline-status.json").write_text(
        json.dumps(summary, indent=2)
    )
    log.info(
        "pipeline ok: dry_run=%s, gguf=%s, hf_repo=%s",
        plan.dry_run,
        gguf_path,
        plan.hf_repo,
    )
    return 0


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__.split("\n\n", 1)[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--base-model",
        required=True,
        help="HF repo id or local path to the base model (e.g. elizaos/eliza-1-0_6b).",
    )
    p.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Root directory for stage outputs, GGUF, manifest, and status.",
    )
    p.add_argument(
        "--apply",
        nargs="+",
        default=list(APPLY_ORDER),
        choices=list(APPLY_ORDER),
        help="Optimization steps to apply (in dependency order).",
    )
    p.add_argument(
        "--calibration",
        type=Path,
        default=None,
        help="Optional calibration JSONL fed to QJL/TurboQuant (PolarQuant ignores it).",
    )
    p.add_argument(
        "--calibration-samples",
        type=int,
        default=128,
    )
    p.add_argument(
        "--gguf-target",
        type=Path,
        default=None,
        help="Optional path to packages/inference (or any directory containing the "
             "elizaOS/llama.cpp checkout). Reserved for future fork-aware "
             "post-processing; the actual GGUF conversion uses --llama-cpp-dir.",
    )
    p.add_argument(
        "--llama-cpp-dir",
        type=Path,
        default=None,
        help="Path to the elizaOS/llama.cpp v1.0.0-eliza checkout. Falls back "
             "to $LLAMA_CPP_DIR env var, then $PATH.",
    )
    p.add_argument(
        "--hf-repo",
        default=None,
        help="HuggingFace repo to publish to (e.g. elizaos/eliza-1-0_6b). "
             "When omitted the pipeline stops after manifest emission.",
    )
    p.add_argument(
        "--drafter-repo",
        default=None,
        help="Optional drafter HF repo id recorded in the manifest (DFlash pairing).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Show the planned commands and emit a manifest preview without "
             "running the apply scripts or talking to HF.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    plan = OptimizationPlan(
        base_model=args.base_model,
        output_dir=args.output_dir.resolve(),
        apply=tuple(args.apply),
        calibration=args.calibration.resolve() if args.calibration else None,
        calibration_samples=args.calibration_samples,
        gguf_target=args.gguf_target.resolve() if args.gguf_target else None,
        llama_cpp_dir=args.llama_cpp_dir.resolve() if args.llama_cpp_dir else None,
        hf_repo=args.hf_repo,
        drafter_repo=args.drafter_repo,
        dry_run=args.dry_run,
        has_cuda=_detect_cuda(),
    )
    log.info("plan: %s", json.dumps({
        "base_model": plan.base_model,
        "output_dir": str(plan.output_dir),
        "apply": list(plan.apply),
        "hf_repo": plan.hf_repo,
        "dry_run": plan.dry_run,
        "has_cuda": plan.has_cuda,
    }, indent=2))
    return execute_plan(plan)


if __name__ == "__main__":
    raise SystemExit(main())
