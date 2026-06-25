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
    promotion_requirements: tuple[str, ...] = ()
    promotion_priority: str = "p2"


@dataclass(frozen=True)
class RepoLocalBenchmarkDirectory:
    benchmark_id: str
    directory: str
    domains: tuple[str, ...]


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
        benchmark_id="nl2repo",
        status=INCLUDED_STATUS,
        domains=("coding",),
        reason=(
            "Natural-language-to-repository coding benchmark with built-in "
            "ElizaOS/OpenCode agent command wiring, trajectory/token capture, "
            "and Docker-backed live scoring."
        ),
        promotion_requirements=(
            "keep Docker-backed evaluator available in CI or a local daemon",
            "capture non-mock ElizaOS and OpenCode trajectories with token usage",
            "monitor live scored rows for stability before raising task counts",
        ),
        promotion_priority="p0",
    ),
    CodeAgentBenchmark(
        benchmark_id="agentbench",
        status=INCLUDED_STATUS,
        domains=("terminal", "browser", "web", "computer-use"),
        reason=(
            "AgentBench OS, WebShop, and Mind2Web-related fixture tasks run "
            "through the ElizaOS/OpenCode bridge with deterministic environment "
            "scoring, right/wrong totals, and trajectory/token telemetry."
        ),
        promotion_requirements=(
            "keep the included AgentBench slice limited to OS/WebShop/Mind2Web-related tasks",
            "capture non-mock ElizaOS and OpenCode trajectories with token usage",
            "promote full upstream AgentBench splits only after data dependencies are stable",
        ),
        promotion_priority="p0",
    ),
    CodeAgentBenchmark(
        benchmark_id="mint",
        status=INCLUDED_STATUS,
        domains=("coding", "tool-use"),
        reason=(
            "MINT HumanEval/MBPP coding subtasks run through the ElizaOS/OpenCode "
            "agent bridge with the benchmark's multi-turn tool/feedback loop, "
            "turn-k scoring, right/wrong totals, and trajectory/token telemetry."
        ),
        promotion_requirements=(
            "keep the selected MINT slice limited to code-generation subtasks",
            "capture non-mock ElizaOS and OpenCode trajectories with token usage",
            "monitor turn-k success stability before raising task counts",
        ),
        promotion_priority="p0",
    ),
    CodeAgentBenchmark(
        benchmark_id="standard_humaneval",
        status=INCLUDED_STATUS,
        domains=("coding",),
        reason=(
            "HumanEval is wrapped as a code-agent function-body task with "
            "ElizaOS/OpenCode agent command execution, sandboxed pass/fail "
            "scoring, and trajectory/token telemetry."
        ),
        promotion_requirements=(
            "keep the sandboxed HumanEval executor green for both adapters",
            "capture non-mock ElizaOS and OpenCode trajectories with token usage",
            "monitor pass@1 stability before raising task counts",
        ),
    ),
    CodeAgentBenchmark(
        benchmark_id="vision_language",
        status=DEFERRED_STATUS,
        domains=("computer-use", "browser", "vision"),
        reason=(
            "The eliza-1 vision-CUA harness exercises real screen capture, VLM "
            "grounding, OCR, and plugin-computeruse clicks, and the "
            "vision-language runner now exposes ElizaOS/OpenCode harness "
            "labels, but it still needs non-stub matched-driver runs before "
            "release-comparable inclusion."
        ),
        promotion_requirements=(
            "validate non-stub ElizaOS and OpenCode runs through the vision-language harness labels",
            "require real eliza-1/VLM input bundles and non-stub desktop capture",
            "normalize grounding/click verification into right/wrong/total plus token and LLM-call telemetry",
        ),
        promotion_priority="p1",
    ),
)


REPO_LOCAL_RELATED_BENCHMARK_DIRS: tuple[RepoLocalBenchmarkDirectory, ...] = (
    RepoLocalBenchmarkDirectory("swe_bench", "swe_bench", ("coding",)),
    RepoLocalBenchmarkDirectory("terminal_bench", "terminal-bench", ("terminal", "coding")),
    RepoLocalBenchmarkDirectory("mind2web", "mind2web", ("browser", "web")),
    RepoLocalBenchmarkDirectory("visualwebbench", "visualwebbench", ("browser", "vision")),
    RepoLocalBenchmarkDirectory("webshop", "webshop", ("browser", "web")),
    RepoLocalBenchmarkDirectory("osworld", "OSWorld", ("computer-use", "desktop")),
    RepoLocalBenchmarkDirectory("nl2repo", "nl2repo", ("coding",)),
    RepoLocalBenchmarkDirectory("agentbench", "agentbench", ("terminal", "browser", "web", "computer-use")),
    RepoLocalBenchmarkDirectory("mint", "mint", ("coding", "tool-use")),
    RepoLocalBenchmarkDirectory("standard_humaneval", "standard", ("coding",)),
    RepoLocalBenchmarkDirectory("vision_language", "eliza-1/vision-cua-e2e", ("computer-use", "browser", "vision")),
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


def repo_local_related_benchmark_dirs() -> tuple[RepoLocalBenchmarkDirectory, ...]:
    return REPO_LOCAL_RELATED_BENCHMARK_DIRS
