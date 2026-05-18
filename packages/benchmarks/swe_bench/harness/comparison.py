"""Head-to-head comparison harness: elizaOS internal agent vs opencode.

Runs the same N SWE-bench instances through two paths and emits a
side-by-side JSON report.

  Path A — elizaOS canonical SWE-bench flow (existing single-shot bridge
  in ``swe_bench.cli``: prompt the TS bench server, extract a unified
  diff, grade with ``SWEBenchEvaluator``).

  Path B — opencode CLI as the patch producer. We clone the target repo
  at ``base_commit`` into a sandbox, invoke ``opencode run "<task>"`` in
  that workdir, then ``git diff`` the working tree to produce a unified
  diff that goes through the same ``SWEBenchEvaluator``.

The two paths share dataset loading, evaluator, and the result schema,
so the only honest delta in the report is the patch producer.

Usage::

    python -m benchmarks.swe_bench.harness.comparison --n 2

If ``opencode`` is not on ``PATH`` the Path B record for each instance
is marked ``status="skipped_opencode_missing"`` and the run continues.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import shutil
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Ensure the eliza-adapter package is importable for Path A.
_ELIZA_ADAPTER_PKG = Path(__file__).resolve().parents[2] / "eliza-adapter"
if _ELIZA_ADAPTER_PKG.exists() and str(_ELIZA_ADAPTER_PKG) not in sys.path:
    sys.path.insert(0, str(_ELIZA_ADAPTER_PKG))

from ..cli import _run_instance as run_path_a_instance  # noqa: E402
from ..dataset import SWEBenchDataset  # noqa: E402
from ..evaluator import SWEBenchEvaluator  # noqa: E402
from ..types import PatchStatus, SWEBenchInstance, SWEBenchVariant  # noqa: E402

logger = logging.getLogger(__name__)

# Default cheap-ish Lite instances to keep smoke runs short. These are
# stable, frequently-cited instances; the runner falls back to whatever
# the dataset returns if any are absent.
DEFAULT_INSTANCES: tuple[str, ...] = (
    "django__django-11099",
    "sympy__sympy-20590",
)


@dataclass
class PathResult:
    """Outcome of running a single instance through one path."""

    path: str  # "elizaos" | "opencode"
    status: str  # "resolved" | "failed" | "no_patch" | "skipped_opencode_missing" | "error" | "not_run_yet"
    patch: str = ""
    resolved: bool = False
    time_s: float = 0.0
    error: str | None = None
    patch_status: str | None = None
    tests_passed: list[str] = field(default_factory=list)
    tests_failed: list[str] = field(default_factory=list)


@dataclass
class ComparisonRecord:
    instance_id: str
    repo: str
    base_commit: str
    path_a: PathResult
    path_b: PathResult
    winner: str  # "elizaos" | "opencode" | "tie_resolved" | "tie_failed"


def _decide_winner(a: PathResult, b: PathResult) -> str:
    if a.resolved and b.resolved:
        return "tie_resolved"
    if a.resolved:
        return "elizaos"
    if b.resolved:
        return "opencode"
    return "tie_failed"


def _opencode_available() -> bool:
    return shutil.which("opencode") is not None


def _build_opencode_task(instance: SWEBenchInstance) -> str:
    """Render the SWE-bench problem statement into an opencode task prompt."""
    hint = (
        f"\n\nHints from the issue:\n{instance.hints_text}"
        if instance.hints_text
        else ""
    )
    return (
        "You are fixing a bug in this repository checkout.\n\n"
        f"Problem statement:\n{instance.problem_statement}{hint}\n\n"
        "Edit files in place to resolve the issue. Do NOT create new commits — "
        "leave the fix as unstaged working-tree changes so the harness can "
        "capture it via `git diff`. Do not modify test files."
    )


async def _git(*args: str, cwd: str | None = None, timeout: int = 120) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        "git",
        *args,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise
    return proc.returncode or 0, stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace")


async def _checkout_instance(
    instance: SWEBenchInstance, sandbox_root: Path
) -> Path:
    """Clone <repo> at <base_commit> into a fresh sandbox directory."""
    workdir = sandbox_root / instance.instance_id
    if workdir.exists():
        shutil.rmtree(workdir, ignore_errors=True)
    workdir.mkdir(parents=True, exist_ok=True)

    url = f"https://github.com/{instance.repo}.git"
    rc, _, err = await _git("clone", "--quiet", url, str(workdir), timeout=600)
    if rc != 0:
        raise RuntimeError(f"git clone failed: {err.strip()}")
    rc, _, err = await _git("checkout", "--quiet", instance.base_commit, cwd=str(workdir))
    if rc != 0:
        raise RuntimeError(f"git checkout {instance.base_commit} failed: {err.strip()}")
    return workdir


async def _run_path_b_instance(
    instance: SWEBenchInstance,
    evaluator: SWEBenchEvaluator,
    sandbox_root: Path,
    opencode_timeout_s: int,
) -> PathResult:
    """Run one instance through opencode and grade the resulting diff."""
    started = time.time()
    if not _opencode_available():
        return PathResult(
            path="opencode",
            status="skipped_opencode_missing",
            error="opencode binary not found on PATH",
            time_s=time.time() - started,
        )

    try:
        workdir = await _checkout_instance(instance, sandbox_root)
    except Exception as exc:  # noqa: BLE001 — surface clone/checkout failure
        return PathResult(
            path="opencode",
            status="error",
            error=f"sandbox setup: {exc}",
            time_s=time.time() - started,
        )

    task = _build_opencode_task(instance)
    proc = await asyncio.create_subprocess_exec(
        "opencode",
        "run",
        task,
        cwd=str(workdir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "OPENCODE_DISABLE_AUTOUPDATE": "1"},
    )
    try:
        _stdout, stderr_bytes = await asyncio.wait_for(
            proc.communicate(), timeout=opencode_timeout_s
        )
        if proc.returncode != 0:
            tail = stderr_bytes.decode("utf-8", "replace").strip().splitlines()[-20:]
            logger.debug("[comparison] opencode rc=%s stderr tail: %s", proc.returncode, "\n".join(tail))
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return PathResult(
            path="opencode",
            status="error",
            error=f"opencode timed out after {opencode_timeout_s}s",
            time_s=time.time() - started,
        )

    rc, diff, err = await _git("diff", "--no-color", cwd=str(workdir))
    if rc != 0:
        return PathResult(
            path="opencode",
            status="error",
            error=f"git diff failed: {err.strip()}",
            time_s=time.time() - started,
        )

    if not diff.strip():
        return PathResult(
            path="opencode",
            status="no_patch",
            time_s=time.time() - started,
        )

    graded = await evaluator.evaluate_patch(instance, diff)
    return PathResult(
        path="opencode",
        status="resolved" if graded.success else "failed",
        patch=diff,
        resolved=graded.success,
        time_s=time.time() - started,
        patch_status=graded.patch_status.value,
        tests_passed=list(graded.tests_passed),
        tests_failed=list(graded.tests_failed),
        error=graded.error,
    )


async def _run_path_a(
    instance: SWEBenchInstance,
    evaluator: SWEBenchEvaluator,
    client: object,
) -> PathResult:
    started = time.time()
    try:
        result = await run_path_a_instance(client, instance, evaluator, provider_label="elizaos")
    except Exception as exc:  # noqa: BLE001 — surface elizaos failure as a record
        return PathResult(
            path="elizaos",
            status="error",
            error=f"elizaos run failed: {exc}",
            time_s=time.time() - started,
        )
    return PathResult(
        path="elizaos",
        status="resolved" if result.success else ("no_patch" if result.patch_status == PatchStatus.NOT_GENERATED else "failed"),
        patch=result.generated_patch,
        resolved=result.success,
        time_s=time.time() - started,
        patch_status=result.patch_status.value,
        tests_passed=list(result.tests_passed),
        tests_failed=list(result.tests_failed),
        error=result.error,
    )


def _stub_record(instance_id: str) -> ComparisonRecord:
    return ComparisonRecord(
        instance_id=instance_id,
        repo="",
        base_commit="",
        path_a=PathResult(path="elizaos", status="not_run_yet"),
        path_b=PathResult(path="opencode", status="not_run_yet"),
        winner="tie_failed",
    )


def _to_payload(records: list[ComparisonRecord]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "totals": {
            "instances": len(records),
            "elizaos_resolved": sum(1 for r in records if r.path_a.resolved),
            "opencode_resolved": sum(1 for r in records if r.path_b.resolved),
            "elizaos_wins": sum(1 for r in records if r.winner == "elizaos"),
            "opencode_wins": sum(1 for r in records if r.winner == "opencode"),
            "ties_resolved": sum(1 for r in records if r.winner == "tie_resolved"),
            "ties_failed": sum(1 for r in records if r.winner == "tie_failed"),
        },
        "records": [asdict(r) for r in records],
    }


async def _run(args: argparse.Namespace) -> int:
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)
    sandbox_root = Path(args.sandbox)
    sandbox_root.mkdir(parents=True, exist_ok=True)

    if args.stub:
        ids = list(args.instances) if args.instances else list(DEFAULT_INSTANCES[: args.n])
        payload = _to_payload([_stub_record(i) for i in ids])
        out_path = out_dir / "comparison_smoke.json"
        out_path.write_text(json.dumps(payload, indent=2))
        print(json.dumps(payload["totals"], indent=2))
        print(f"\nStub report: {out_path}")
        return 0

    dataset = SWEBenchDataset(variant=SWEBenchVariant.LITE)
    await dataset.load()
    requested = list(args.instances) if args.instances else list(DEFAULT_INSTANCES[: args.n])
    all_instances = list(dataset.get_instances(limit=None))
    by_id = {i.instance_id: i for i in all_instances}
    instances = [by_id[i] for i in requested if i in by_id][: args.n]
    if not instances:
        instances = all_instances[: args.n]
    if not instances:
        print("No instances available; aborting.", file=sys.stderr)
        return 2

    evaluator = SWEBenchEvaluator(
        workspace_dir=str(sandbox_root / "_eval"),
        timeout_seconds=args.timeout,
        use_docker=not args.no_docker,
    )

    # Path A needs the eliza TS bridge; defer the import so --stub works
    # without the adapter package present.
    from eliza_adapter import ElizaServerManager  # type: ignore[import-not-found]

    eliza_server = ElizaServerManager()
    eliza_server.start()
    client = eliza_server.client
    records: list[ComparisonRecord] = []
    timestamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    out_path = out_dir / f"comparison_{timestamp}.json"
    try:
        for idx, inst in enumerate(instances):
            logger.info("[comparison] %d/%d %s", idx + 1, len(instances), inst.instance_id)
            a = await _run_path_a(inst, evaluator, client)
            b = await _run_path_b_instance(
                inst, evaluator, sandbox_root, opencode_timeout_s=args.opencode_timeout
            )
            records.append(
                ComparisonRecord(
                    instance_id=inst.instance_id,
                    repo=inst.repo,
                    base_commit=inst.base_commit,
                    path_a=a,
                    path_b=b,
                    winner=_decide_winner(a, b),
                )
            )
    finally:
        eliza_server.stop()
        # Persist whatever we have, even on KeyboardInterrupt / unhandled errors.
        out_path.write_text(json.dumps(_to_payload(records), indent=2))

    payload = _to_payload(records)
    print(json.dumps(payload["totals"], indent=2))
    print(f"\nReport: {out_path}")
    return 0


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="benchmarks.swe_bench.harness.comparison",
        description="Head-to-head: elizaOS internal agent vs opencode on SWE-bench Lite.",
    )
    p.add_argument("--n", type=int, default=2, help="Number of instances to run (default: 2)")
    p.add_argument(
        "--instances",
        nargs="+",
        default=None,
        help="Explicit SWE-bench Lite instance IDs (overrides --n selection)",
    )
    p.add_argument(
        "--output",
        default="./benchmark_results/swe-bench-comparison",
        help="Output directory for the comparison JSON",
    )
    p.add_argument(
        "--sandbox",
        default="./swe-bench-comparison-sandbox",
        help="Scratch directory for per-instance opencode clones",
    )
    p.add_argument(
        "--timeout",
        type=int,
        default=600,
        help="Evaluator (per-instance grading) timeout in seconds",
    )
    p.add_argument(
        "--opencode-timeout",
        type=int,
        default=900,
        help="Per-instance budget for the opencode subprocess in seconds",
    )
    p.add_argument(
        "--no-docker",
        action="store_true",
        help="Skip Docker grading (use basic validator — useful for local smokes)",
    )
    p.add_argument(
        "--stub",
        action="store_true",
        help="Emit a placeholder comparison_smoke.json without executing either path",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=os.environ.get("SWE_BENCH_LOG_LEVEL", "INFO"),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    return asyncio.run(_run(_parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
