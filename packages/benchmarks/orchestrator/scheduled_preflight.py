"""Provision immutable inputs for the scheduled real-model benchmark lane.

The workflow invokes this before model execution so missing dependencies,
unavailable upstreams, stale snapshots, and corpus drift fail at one boundary.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Callable

from benchmarks.publication_contracts import (
    ACTION_CALLING_FULL_BASE_CASE_COUNT,
    ACTION_CALLING_FULL_SCENARIO_COUNT,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
SCHEDULED_BENCHMARKS = frozenset(
    {"bfcl", "action-calling", "tau_bench", "mint", "context_bench"}
)
NONPUBLISHABLE_SCHEDULED_BENCHMARKS = {
    "agentbench": (
        "AgentBench is diagnostic-only until all eight official environments, "
        "including the pinned OS create/init/start/check/answer protocol, execute "
        "with full corpus coverage"
    )
}
ACTION_CALLING_SOURCE = "hermes-fc-v1"
ACTION_CALLING_EXPECTED_EXAMPLES = ACTION_CALLING_FULL_BASE_CASE_COUNT
TAU_BENCH_UPSTREAM_REF = "59a200c6d575d595120f1cb70fea53cef0632f6b"
SCHEDULED_PROFILE = (
    REPOSITORY_ROOT
    / "packages"
    / "benchmarks"
    / "orchestrator"
    / "profiles"
    / "scheduled-core.json"
)


def parse_benchmarks(raw: str) -> tuple[str, ...]:
    """Parse and validate the workflow's scheduled benchmark selection."""
    selected = tuple(part.strip() for part in raw.split(",") if part.strip())
    if not selected:
        raise ValueError("scheduled benchmark selection must not be empty")
    if len(set(selected)) != len(selected):
        raise ValueError(
            f"scheduled benchmark selection contains duplicates: {selected!r}"
        )
    quarantined = sorted(set(selected) & NONPUBLISHABLE_SCHEDULED_BENCHMARKS.keys())
    if quarantined:
        reasons = [
            f"{benchmark_id}: {NONPUBLISHABLE_SCHEDULED_BENCHMARKS[benchmark_id]}"
            for benchmark_id in quarantined
        ]
        raise ValueError(
            "scheduled publication refuses quarantined benchmarks: "
            + "; ".join(reasons)
        )
    unsupported = sorted(set(selected) - SCHEDULED_BENCHMARKS)
    if unsupported:
        raise ValueError(
            "scheduled preflight has no provisioning contract for: "
            + ", ".join(unsupported)
        )
    return selected


def verify_locked_dependencies() -> None:
    """Import every direct dependency supplied by the hash-locked environment."""
    for module_name in ("huggingface_hub", "httpx", "pydantic", "yaml"):
        importlib.import_module(module_name)


def verify_scheduled_profile() -> None:
    """Fail if the workflow profile selects an incomplete or unsupported slice."""
    profile = json.loads(SCHEDULED_PROFILE.read_text(encoding="utf-8"))
    if not isinstance(profile, dict):
        raise RuntimeError("scheduled benchmark profile must be a JSON object")
    extra = profile.get("extra")
    per_benchmark = extra.get("per_benchmark") if isinstance(extra, dict) else None
    action_config = (
        per_benchmark.get("action-calling") if isinstance(per_benchmark, dict) else None
    )
    expected = {
        "max_examples": None,
        "expected_examples": ACTION_CALLING_FULL_BASE_CASE_COUNT,
        "expand_scenarios": True,
    }
    if not isinstance(action_config, dict) or action_config != expected:
        raise RuntimeError(
            "scheduled Action Calling profile must select the complete publication "
            f"workload ({ACTION_CALLING_FULL_SCENARIO_COUNT} scenarios)"
        )
    if isinstance(per_benchmark, dict) and "agentbench" in per_benchmark:
        raise RuntimeError(
            "scheduled AgentBench publication is quarantined until complete official "
            "environment parity and corpus coverage are available"
        )


def _run(command: list[str], *, cwd: Path, pythonpath: Path | None = None) -> None:
    env = os.environ.copy()
    if pythonpath is not None:
        existing = env.get("PYTHONPATH")
        env["PYTHONPATH"] = (
            f"{pythonpath}{os.pathsep}{existing}" if existing else str(pythonpath)
        )
    subprocess.run(command, cwd=cwd, env=env, check=True)


def provision_bfcl() -> None:
    """Resolve and verify the exact BFCL files consumed by this lane."""
    from huggingface_hub import snapshot_download

    from benchmarks.bfcl.types import BFCLConfig

    config = BFCLConfig()
    snapshot = Path(
        snapshot_download(
            repo_id=config.huggingface_dataset,
            repo_type="dataset",
            revision=config.dataset_revision,
        )
    )
    required = tuple(
        path
        for filename in ("BFCL_v3_multiple.json", "BFCL_v3_parallel.json")
        for path in (snapshot / filename, snapshot / "possible_answer" / filename)
    )
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise FileNotFoundError(
            "pinned BFCL scheduled subset is incomplete: " + ", ".join(missing)
        )


def provision_action_calling() -> None:
    """Build and validate the official native Hermes action-calling corpus."""
    training_root = REPOSITORY_ROOT / "packages" / "training"
    _run(
        [
            sys.executable,
            "scripts/download_datasets.py",
            "--only",
            ACTION_CALLING_SOURCE,
            "--max-workers",
            "1",
            "--min-free-gb",
            "2",
        ],
        cwd=training_root,
    )
    _run(
        [
            sys.executable,
            "scripts/normalize.py",
            "--only",
            ACTION_CALLING_SOURCE,
        ],
        cwd=training_root,
    )
    _run(
        [
            sys.executable,
            "scripts/prepare_native_tool_calling_data.py",
            "--transform-normalized",
            "--validate-native",
            "--only",
            ACTION_CALLING_SOURCE,
        ],
        cwd=training_root,
    )
    _run(
        [
            sys.executable,
            "-m",
            "benchmarks.action-calling.cli",
            "--provider",
            "vllm",
            "--model",
            "preflight",
            "--count-scenarios",
            "--expand-scenarios",
            "--expected-examples",
            str(ACTION_CALLING_EXPECTED_EXAMPLES),
        ],
        cwd=REPOSITORY_ROOT,
        pythonpath=REPOSITORY_ROOT / "packages",
    )


def provision_agentbench() -> None:
    """Fetch and execute the database diagnostic without making it publishable."""
    package_root = REPOSITORY_ROOT / "packages" / "benchmarks" / "agentbench"
    for command in ("fetch", "verify"):
        _run(
            [
                sys.executable,
                "-m",
                "elizaos_agentbench.cli",
                "data",
                command,
            ],
            cwd=package_root,
            pythonpath=package_root,
        )
    _run(
        [
            sys.executable,
            "-m",
            "elizaos_agentbench.preflight",
        ],
        cwd=package_root,
        pythonpath=package_root,
    )


def provision_tau_bench() -> None:
    """Fetch the pinned official retail assets selected by the lane profile."""
    package_root = REPOSITORY_ROOT / "packages" / "benchmarks" / "tau-bench"
    _run(
        [
            sys.executable,
            "-c",
            (
                "from elizaos_tau_bench.data_assets import UPSTREAM_REF, data_provenance\n"
                f"expected = '{TAU_BENCH_UPSTREAM_REF}'\n"
                "if UPSTREAM_REF != expected:\n"
                "    raise RuntimeError("
                "f'tau-bench ref mismatch: expected {expected}, got {UPSTREAM_REF}')\n"
                "provenance = data_provenance(['retail'])\n"
                "if provenance['upstream_ref'] != expected:\n"
                "    raise RuntimeError('tau-bench provenance ref mismatch')\n"
            ),
        ],
        cwd=package_root,
        pythonpath=package_root,
    )


PROVISIONERS: dict[str, Callable[[], None]] = {
    "bfcl": provision_bfcl,
    "action-calling": provision_action_calling,
    "tau_bench": provision_tau_bench,
}


def run_preflight(selected: tuple[str, ...]) -> None:
    """Provision selected external inputs, propagating the first failure."""
    verify_locked_dependencies()
    verify_scheduled_profile()
    for benchmark_id in selected:
        provision = PROVISIONERS.get(benchmark_id)
        if provision is not None:
            print(f"Provisioning scheduled benchmark input: {benchmark_id}", flush=True)
            provision()
    print("Scheduled benchmark preflight passed.", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmarks", required=True)
    args = parser.parse_args(argv)
    run_preflight(parse_benchmarks(args.benchmarks))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
