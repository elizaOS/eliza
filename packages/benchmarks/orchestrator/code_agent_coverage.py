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
        benchmark_id="swe_bench_pro",
        status=DEFERRED_STATUS,
        domains=("coding",),
        reason=(
            "Long-horizon SWE-bench Pro now has a patch-generation wrapper, "
            "but remains deferred until matched non-mock ElizaOS/OpenCode "
            "runs are validated against the Docker/Modal evaluator."
        ),
        promotion_requirements=(
            "run non-mock ElizaOS/OpenCode patch generation on the public split",
            "validate local Docker or Modal scoring for generated patches",
            "capture live per-agent trajectory token and call telemetry",
        ),
        promotion_priority="p1",
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
        benchmark_id="app_eval_coding",
        status=INCLUDED_STATUS,
        domains=("coding",),
        reason=(
            "App Eval coding tasks are materialized into isolated TypeScript "
            "workspaces and run through matched ElizaOS/OpenCode command "
            "templates with file, command, test, trajectory, and token telemetry."
        ),
        promotion_requirements=(
            "keep coding-task assertions deterministic and non-LLM judged",
            "capture non-mock ElizaOS and OpenCode workspace trajectories with token usage",
            "monitor live task stability before raising task counts",
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
        benchmark_id="qwen_web_bench",
        status=DEFERRED_STATUS,
        domains=("coding", "browser", "web"),
        reason=(
            "QwenWebBench is a front-end code-generation/browser-rendering "
            "benchmark placeholder in this repo, but the upstream dataset and "
            "runner are not public yet."
        ),
        promotion_requirements=(
            "track upstream release of the public runner and dataset",
            "add an ElizaOS/OpenCode artifact-generation adapter once runner shape is known",
            "normalize visual judge or Elo outcomes into reportable head-to-head rows",
        ),
    ),
    CodeAgentBenchmark(
        benchmark_id="openclaw_benchmark",
        status=INCLUDED_STATUS,
        domains=("coding", "terminal"),
        reason=(
            "OpenClaw benchmark execution scenarios run through the same "
            "ElizaOS/OpenCode agent bridge with shared-sandbox tool execution, "
            "deterministic rubric scoring, right/wrong totals, and "
            "trajectory/token telemetry."
        ),
        promotion_requirements=(
            "keep setup/implementation/testing scenarios deterministic",
            "capture non-mock ElizaOS and OpenCode trajectories with token usage",
            "run the full ordered scenario set for release-comparable reports",
        ),
        promotion_priority="p0",
    ),
    CodeAgentBenchmark(
        benchmark_id="claw_eval",
        status=INCLUDED_STATUS,
        domains=("coding", "terminal", "agent"),
        reason=(
            "Claw-Eval deterministic coding tasks run through matched "
            "ElizaOS/OpenCode command templates and are scored with the "
            "benchmark's non-LLM YAML keyword/tool-call components."
        ),
        promotion_requirements=(
            "keep the included slice limited to non-LLM-judged coding tasks",
            "capture non-mock ElizaOS and OpenCode trajectories with token usage",
            "promote browser/computer-use and Pass^3 judge tasks only after stable non-LLM scoring exists",
        ),
        promotion_priority="p0",
    ),
    CodeAgentBenchmark(
        benchmark_id="qwen_claw_bench",
        status=INCLUDED_STATUS,
        domains=("coding", "terminal", "computer-use", "agent"),
        reason=(
            "QwenClawBench's deterministic automated workspace task runs "
            "through matched ElizaOS/OpenCode command templates with embedded "
            "Python grading, right/wrong totals, and trajectory/token telemetry."
        ),
        promotion_requirements=(
            "keep the included slice limited to automated non-LLM-judged tasks",
            "capture non-mock ElizaOS and OpenCode trajectories with token usage",
            "promote hybrid and LLM-judge tasks only after judge dependencies are stable",
        ),
        promotion_priority="p0",
    ),
    CodeAgentBenchmark(
        benchmark_id="clawbench",
        status=INCLUDED_STATUS,
        domains=("terminal", "browser", "computer-use", "tool-use"),
        reason=(
            "ClawBench is a deterministic multi-tool workspace benchmark with "
            "exec, read, Slack, memory, and web tools; the matrix runs the same "
            "scenario fixtures through the ElizaOS/OpenCode bridge and "
            "normalizes rubric scores into right/wrong totals with trajectory "
            "and token telemetry."
        ),
        promotion_requirements=(
            "keep ClawBench scenarios deterministic and non-LLM judged",
            "capture non-mock ElizaOS and OpenCode trajectories with token usage",
            "monitor full-scenario score stability before raising release gates",
        ),
        promotion_priority="p0",
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
    RepoLocalBenchmarkDirectory("swe_bench_multilingual", "swe-bench-multilingual", ("coding",)),
    RepoLocalBenchmarkDirectory("nl2repo", "nl2repo", ("coding",)),
    RepoLocalBenchmarkDirectory("swe_bench_pro", "swe-bench-pro", ("coding",)),
    RepoLocalBenchmarkDirectory("agentbench", "agentbench", ("terminal", "browser", "web", "computer-use")),
    RepoLocalBenchmarkDirectory("mint", "mint", ("coding", "tool-use")),
    RepoLocalBenchmarkDirectory("app_eval_coding", "app-eval", ("coding",)),
    RepoLocalBenchmarkDirectory("standard_humaneval", "standard", ("coding",)),
    RepoLocalBenchmarkDirectory("qwen_web_bench", "qwen-web-bench", ("coding", "browser", "web")),
    RepoLocalBenchmarkDirectory("openclaw_benchmark", "openclaw-benchmark", ("coding", "terminal")),
    RepoLocalBenchmarkDirectory("claw_eval", "claw-eval", ("coding", "browser", "computer-use", "agent")),
    RepoLocalBenchmarkDirectory("qwen_claw_bench", "qwen-claw-bench", ("coding", "terminal", "computer-use", "agent")),
    RepoLocalBenchmarkDirectory("clawbench", "clawbench", ("terminal", "browser", "computer-use", "tool-use")),
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
