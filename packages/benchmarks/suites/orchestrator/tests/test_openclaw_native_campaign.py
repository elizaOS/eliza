"""Guards publishable benchmark entrypoints against OpenClaw provider bypasses.

Parser/retry coverage remains inside the adapter package, while production
benchmark factories must enter OpenClaw through its isolated embedded runtime.
"""

from __future__ import annotations

import tokenize
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
_BYPASS_MARKERS = (
    "direct_openai_compatible",
    "OPENCLAW_DIRECT_OPENAI_COMPAT",
    "OPENCLAW_USE_CLI",
)
_ALLOWED_IMPLEMENTATION_FILES = {
    "harnesses/openclaw/openclaw_adapter/client.py",
    # This public constructor rejects a truthy bypass request before creating
    # its client; retaining the fail-closed argument protects direct callers.
    "harnesses/openclaw/openclaw_adapter/tau_bench.py",
}
_REQUIRED_CAMPAIGN_FACTORIES = {
    "suites/abliteration-robustness/cli.py",
    "suites/action-calling/cli.py",
    "suites/clawbench/clawbench/multi_harness_runner.py",
    "suites/eliza-1/scripts/harness_runner.py",
    "harnesses/eliza/eliza_adapter/mmau.py",
    "framework/scripts/harness_runner.py",
    "harnesses/hermes/hermes_adapter/harness_openai_proxy.py",
    "harnesses/hermes/hermes_adapter/swe_env_smoke.py",
    "suites/lifeops-bench/eliza_lifeops_bench/__main__.py",
    "suites/multitask-bench/multitask_bench/harness.py",
    "suites/openclaw-benchmark/eliza_adapter.py",
    "suites/standard/_base.py",
    "suites/swe_bench/cli.py",
    "suites/tau-bench/elizaos_tau_bench/harness_agents.py",
    "suites/terminal-bench/elizaos_terminal_bench/runner.py",
}


def test_production_openclaw_factories_cannot_select_direct_provider_transport() -> None:
    offenders: list[str] = []
    scanned_factories: set[str] = set()
    for path in sorted(REPO_ROOT.rglob("*.py")):
        relative = path.relative_to(REPO_ROOT).as_posix()
        if "tests" in path.relative_to(REPO_ROOT).parts:
            continue
        with tokenize.open(path) as handle:
            source = handle.read()
        if "OpenClawClient" not in source:
            continue
        scanned_factories.add(relative)
        if relative in _ALLOWED_IMPLEMENTATION_FILES:
            continue
        matched = [marker for marker in _BYPASS_MARKERS if marker in source]
        if matched:
            offenders.append(f"{relative}: {', '.join(matched)}")

    assert offenders == [], (
        "production OpenClaw factories must use the embedded runtime; "
        f"bypass selectors found in {offenders}"
    )
    missing = sorted(_REQUIRED_CAMPAIGN_FACTORIES - scanned_factories)
    assert missing == [], f"campaign factory coverage drifted; missing {missing}"
