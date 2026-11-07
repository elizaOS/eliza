"""Release publishing: verification."""

from __future__ import annotations
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any, Mapping, Sequence
from eliza_training.release.gates import (  # noqa: E402  - sys.path mutated above
    GateReport,
    apply_gates,
    load_gates,
    regression_gates,
)
from eliza_training.manifest.eliza1_manifest import (  # noqa: E402
    ELIZA_1_BACKENDS,
    SUPPORTED_BACKENDS_BY_TIER,
    KernelVerification,
)
from .context import (
    EXIT_EVAL_GATE_FAIL,
    EXIT_KERNEL_VERIFY_FAIL,
    OrchestratorError,
    PublishContext,
    _git_short_sha,
    _optional_float,
)
from .evidence import _text_model_sha256s
from .layout import _mtp_report_eval


def _verify_dir(ctx: PublishContext) -> Path:
    """Resolve the native local-inference verify harness."""
    repo_root = ctx.training_repo_root.parent.parent
    native = repo_root / "plugins" / "plugin-local-inference" / "native" / "verify"
    if (native / "Makefile").is_file():
        return native
    return ctx.training_repo_root.parent / "inference" / "verify"


def _is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(c in "0123456789abcdef" for c in value)
    )


def _read_recorded_report(
    path: Path,
    expected_backend: str,
    *,
    expected_at_commit: str,
    model_sha256s: set[str],
) -> KernelVerification:
    if not path.is_file():
        raise OrchestratorError(
            f"verification report not found: {path}",
            EXIT_KERNEL_VERIFY_FAIL,
        )
    data = json.loads(path.read_text())
    backend = data.get("backend") or expected_backend
    if backend != expected_backend:
        raise OrchestratorError(
            f"verification report at {path} is for backend "
            f"{backend!r}, expected {expected_backend!r}",
            EXIT_KERNEL_VERIFY_FAIL,
        )
    status = data.get("status")
    if status != "pass":
        raise OrchestratorError(
            f"{expected_backend} verification report status is "
            f"{status!r}, expected 'pass' (path={path})",
            EXIT_KERNEL_VERIFY_FAIL,
        )
    at_commit = data.get("atCommit") or data.get("at_commit")
    report = data.get("report") or path.name
    if not at_commit:
        raise OrchestratorError(
            f"verification report at {path} missing atCommit",
            EXIT_KERNEL_VERIFY_FAIL,
        )
    if at_commit != expected_at_commit:
        raise OrchestratorError(
            f"verification report at {path} was recorded at commit "
            f"{at_commit!r}, expected {expected_at_commit!r}",
            EXIT_KERNEL_VERIFY_FAIL,
        )
    model_sha = (
        data.get("modelSha256") or data.get("ggufSha256") or data.get("artifactSha256")
    )
    if not _is_sha256(model_sha):
        raise OrchestratorError(
            f"verification report at {path} missing modelSha256/ggufSha256/"
            "artifactSha256",
            EXIT_KERNEL_VERIFY_FAIL,
        )
    if model_sha not in model_sha256s:
        raise OrchestratorError(
            f"verification report at {path} model sha256 {model_sha!r} does "
            "not match a shipped text GGUF",
            EXIT_KERNEL_VERIFY_FAIL,
        )
    return KernelVerification(status="pass", at_commit=at_commit, report=report)


def _run_reference_test(verify_dir: Path) -> None:
    """Run ``make -C verify reference-test``. CI-safe per Makefile."""
    if not (verify_dir / "Makefile").is_file():
        raise OrchestratorError(
            f"kernel verify dir missing Makefile: {verify_dir}",
            EXIT_KERNEL_VERIFY_FAIL,
        )
    if shutil.which("make") is None:
        raise OrchestratorError(
            "kernel verify: 'make' not on PATH; cannot run reference-test",
            EXIT_KERNEL_VERIFY_FAIL,
        )
    proc = subprocess.run(
        ["make", "-C", str(verify_dir), "reference-test"],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise OrchestratorError(
            "kernel verify: reference-test failed:\n"
            f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}",
            EXIT_KERNEL_VERIFY_FAIL,
        )


def run_kernel_verification(
    ctx: PublishContext,
    layout: Mapping[str, Sequence[Path]],
) -> dict[str, KernelVerification]:
    """Produce a backend → verification map per ``ELIZA_1_BACKENDS``.

    Rules:

    - CPU is always verified via ``make reference-test``.
    - Vulkan is verified via the recorded report at
      ``bundle/evals/vulkan_verify.json`` if present, otherwise CI
      treats it as not-applicable to this tier and records ``skipped``
      only when the tier does not include vulkan in
      ``SUPPORTED_BACKENDS_BY_TIER``.
    - Metal is hardware-only. The orchestrator REQUIRES
      ``--metal-verification PATH`` when the tier includes metal, and
      consumes that report directly. There is no inline metal run.
    - CUDA: same shape — recorded report at
      ``bundle/evals/cuda_verify.json`` if the tier supports it.
    - ROCm: same shape — recorded report at
      ``bundle/evals/rocm_verify.json`` if the tier supports it.
    """

    supported = set(SUPPORTED_BACKENDS_BY_TIER[ctx.tier])
    sha = _git_short_sha(ctx.training_repo_root)
    model_sha256s = _text_model_sha256s(ctx, layout)

    out: dict[str, KernelVerification] = {}

    # CPU — always run reference-test (CI-safe).
    if "cpu" in supported:
        verify_dir = _verify_dir(ctx)
        _run_reference_test(verify_dir)
        out["cpu"] = KernelVerification(
            status="pass", at_commit=sha, report="reference-test"
        )

    # Vulkan — recorded report from the bundle if tier includes it.
    if "vulkan" in supported:
        recorded = ctx.bundle_dir / "evals" / "vulkan_verify.json"
        out["vulkan"] = _read_recorded_report(
            recorded,
            "vulkan",
            expected_at_commit=sha,
            model_sha256s=model_sha256s,
        )

    # Metal — hardware-only.
    if "metal" in supported:
        if ctx.metal_verification is None:
            raise OrchestratorError(
                f"tier {ctx.tier} requires Metal verification "
                "(NEEDS-HARDWARE). Run plugins/plugin-local-inference/native/verify/metal_verify "
                "on a verified host and pass --metal-verification PATH.",
                EXIT_KERNEL_VERIFY_FAIL,
            )
        out["metal"] = _read_recorded_report(
            ctx.metal_verification,
            "metal",
            expected_at_commit=sha,
            model_sha256s=model_sha256s,
        )

    # CUDA — recorded report.
    if "cuda" in supported:
        recorded = ctx.bundle_dir / "evals" / "cuda_verify.json"
        out["cuda"] = _read_recorded_report(
            recorded,
            "cuda",
            expected_at_commit=sha,
            model_sha256s=model_sha256s,
        )

    # ROCm — recorded report.
    if "rocm" in supported:
        recorded = ctx.bundle_dir / "evals" / "rocm_verify.json"
        out["rocm"] = _read_recorded_report(
            recorded,
            "rocm",
            expected_at_commit=sha,
            model_sha256s=model_sha256s,
        )

    # Backends not supported by this tier are recorded as skipped, with
    # a stable report name. The manifest validator only enforces "pass"
    # on backends in SUPPORTED_BACKENDS_BY_TIER[tier], so skipped
    # entries here are non-blocking.
    for backend in ELIZA_1_BACKENDS:
        if backend not in out:
            out[backend] = KernelVerification(
                status="skipped",
                at_commit=sha,
                report=f"not-applicable-for-{ctx.tier}",
            )

    return out


def run_eval_gates(ctx: PublishContext) -> tuple[GateReport, dict[str, Any]]:
    """Apply the tier gates to ``evals/aggregate.json``.

    The eval blob shape matches the docstring of ``eliza1_gates.py``.
    Refuses to proceed unless ``GateReport.passed`` is True.
    """

    eval_path = ctx.bundle_dir / "evals" / "aggregate.json"
    eval_blob = json.loads(eval_path.read_text())

    if eval_blob.get("tier") != ctx.tier:
        raise OrchestratorError(
            f"evals/aggregate.json tier {eval_blob.get('tier')!r} does "
            f"not match --tier {ctx.tier!r}",
            EXIT_EVAL_GATE_FAIL,
        )

    results = eval_blob.get("results")
    if isinstance(results, dict):
        mtp_report = _mtp_report_eval(ctx)
        enriched_results = dict(results)
        if (
            _optional_float(enriched_results.get("mtp_acceptance")) is None
            and _optional_float(mtp_report.get("acceptanceRate")) is not None
        ):
            enriched_results["mtp_acceptance"] = mtp_report["acceptanceRate"]
        if (
            _optional_float(enriched_results.get("mtp_speedup")) is None
            and _optional_float(mtp_report.get("speedup")) is not None
        ):
            enriched_results["mtp_speedup"] = mtp_report["speedup"]
        if enriched_results != results:
            eval_blob = dict(eval_blob)
            eval_blob["results"] = enriched_results

    gates_doc = load_gates(ctx.gates_path) if ctx.gates_path else None
    report = apply_gates(eval_blob, gates_doc)

    # Regression check vs. the previously-published bundle. The audit
    # (wave1/eval-benchmarks.md §11 H5) flagged that the per-tier threshold
    # gate accepts any measurement at-or-above the threshold even when the
    # previous publish scored materially higher. Compare measured vs prior;
    # publish-block on a regression beyond ``ctx.regression_tolerance``.
    baseline_results = _read_prior_aggregate(ctx)
    if isinstance(baseline_results, Mapping):
        report.gates.extend(
            regression_gates(
                eval_blob.get("results") or {},
                baseline_results,
                tolerance=ctx.regression_tolerance,
            )
        )

    if not report.passed:
        details = "\n".join(f"  - {g.name}: {g.reason}" for g in report.failed_gates)
        raise OrchestratorError(
            f"eval gates failed for tier {ctx.tier}:\n{details}",
            EXIT_EVAL_GATE_FAIL,
        )

    return report, eval_blob


def _read_prior_aggregate(ctx: PublishContext) -> Mapping[str, Any] | None:
    """Return the prior bundle's ``results`` dict, or ``None`` to skip.

    Reads ``ctx.prior_bundle_aggregate``. The shape mirrors the live
    aggregate blob (``{"tier", "mode", "results"}``); we return the
    ``results`` sub-dict directly. A missing / unreadable file returns
    ``None`` (treated as "no baseline → first publish path").
    """
    src = ctx.prior_bundle_aggregate
    if src is None or not src.is_file():
        return None
    try:
        blob = json.loads(src.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise OrchestratorError(
            f"--prior-bundle-aggregate {src} is not valid JSON: {exc}",
            EXIT_EVAL_GATE_FAIL,
        ) from exc
    if not isinstance(blob, dict):
        raise OrchestratorError(
            f"--prior-bundle-aggregate {src} must be a JSON object",
            EXIT_EVAL_GATE_FAIL,
        )
    if isinstance(blob.get("results"), dict):
        return blob["results"]
    return blob
