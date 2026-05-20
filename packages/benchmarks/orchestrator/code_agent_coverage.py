"""Coverage manifest for code-agent matrix benchmarks."""

from __future__ import annotations

from dataclasses import dataclass

INCLUDED_STATUS = "included"
DEFERRED_STATUS = "deferred"


@dataclass(frozen=True)
class CodeAgentBenchmark:
    benchmark_id: str
    status: str
    domains: tuple[str, ...]
    reason: str


CODE_AGENT_COVERAGE: tuple[CodeAgentBenchmark, ...] = (
    CodeAgentBenchmark(
        benchmark_id="swe_bench",
        status=INCLUDED_STATUS,
        domains=("coding",),
        reason="Python issue-resolution benchmark with the eliza adapter bridge.",
    ),
    CodeAgentBenchmark(
        benchmark_id="terminal_bench",
        status=INCLUDED_STATUS,
        domains=("terminal", "coding"),
        reason="Terminal task benchmark with task-agent adapter selection.",
    ),
    CodeAgentBenchmark(
        benchmark_id="mind2web",
        status=INCLUDED_STATUS,
        domains=("browser", "web"),
        reason="Browser interaction benchmark routed through the eliza bridge.",
    ),
    CodeAgentBenchmark(
        benchmark_id="visualwebbench",
        status=INCLUDED_STATUS,
        domains=("browser", "vision"),
        reason="Visual browser benchmark routed through the eliza bridge.",
    ),
    CodeAgentBenchmark(
        benchmark_id="webshop",
        status=INCLUDED_STATUS,
        domains=("browser", "web"),
        reason="Shopping-agent browser benchmark with bridge-backed agent calls.",
    ),
    CodeAgentBenchmark(
        benchmark_id="osworld",
        status=INCLUDED_STATUS,
        domains=("computer-use", "desktop"),
        reason="Desktop computer-use benchmark via the OSWorld eliza bridge.",
    ),
    CodeAgentBenchmark(
        benchmark_id="swe_bench_multilingual",
        status=INCLUDED_STATUS,
        domains=("coding",),
        reason=(
            "SWE-bench Multilingual is routed through the shared SWE-bench "
            "adapter bridge with the multilingual dataset variant."
        ),
    ),
    CodeAgentBenchmark(
        benchmark_id="nl2repo",
        status=DEFERRED_STATUS,
        domains=("coding",),
        reason=(
            "Selectable for harness validation, but release-comparable scoring "
            "still depends on Docker evaluator readiness."
        ),
    ),
    CodeAgentBenchmark(
        benchmark_id="swe_bench_pro",
        status=DEFERRED_STATUS,
        domains=("coding",),
        reason=(
            "Long-horizon SWE-bench Pro tasks require a dedicated prediction "
            "generation bridge and Docker/Modal evaluation plumbing."
        ),
    ),
    CodeAgentBenchmark(
        benchmark_id="agentbench",
        status=DEFERRED_STATUS,
        domains=("terminal", "browser", "web", "computer-use"),
        reason=(
            "AgentBench includes OS, WebShop, and Mind2Web-related environments, "
            "but its current harness targets Eliza/Hermes/OpenClaw rather than "
            "the ElizaOS/OpenCode matrix adapters."
        ),
    ),
    CodeAgentBenchmark(
        benchmark_id="mint",
        status=DEFERRED_STATUS,
        domains=("coding", "tool-use"),
        reason=(
            "MINT includes HumanEval/MBPP code-generation tool tasks, but it "
            "needs an ElizaOS/OpenCode code-agent adapter bridge before "
            "head-to-head matrix scoring."
        ),
    ),
    CodeAgentBenchmark(
        benchmark_id="app_eval_coding",
        status=DEFERRED_STATUS,
        domains=("coding",),
        reason=(
            "App Eval has coding tasks, but they are heuristic app-agent "
            "regression checks without an OpenCode-comparable adapter path."
        ),
    ),
    CodeAgentBenchmark(
        benchmark_id="standard_humaneval",
        status=DEFERRED_STATUS,
        domains=("coding",),
        reason=(
            "HumanEval is a model-level code-generation benchmark; it needs a "
            "workspace/code-agent wrapper before it is comparable to OpenCode."
        ),
    ),
)


def included_benchmark_ids() -> tuple[str, ...]:
    return tuple(
        item.benchmark_id
        for item in CODE_AGENT_COVERAGE
        if item.status == INCLUDED_STATUS
    )


def deferred_benchmark_ids() -> tuple[str, ...]:
    return tuple(
        item.benchmark_id
        for item in CODE_AGENT_COVERAGE
        if item.status == DEFERRED_STATUS
    )


def coverage_status_by_id() -> dict[str, CodeAgentBenchmark]:
    return {item.benchmark_id: item for item in CODE_AGENT_COVERAGE}
