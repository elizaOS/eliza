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
        status=DEFERRED_STATUS,
        domains=("coding",),
        reason=(
            "Selectable for harness validation, but release-comparable scoring "
            "still depends on Docker evaluator readiness."
        ),
        promotion_requirements=(
            "run Docker-backed evaluator in CI or a local daemon",
            "capture non-mock ElizaOS and OpenCode trajectories with token usage",
            "enable coverage gate after live scored rows are stable",
        ),
        promotion_priority="p0",
    ),
    CodeAgentBenchmark(
        benchmark_id="swe_bench_pro",
        status=DEFERRED_STATUS,
        domains=("coding",),
        reason=(
            "Long-horizon SWE-bench Pro tasks require a dedicated prediction "
            "generation bridge and Docker/Modal evaluation plumbing."
        ),
        promotion_requirements=(
            "build ElizaOS/OpenCode prediction-generation commands",
            "normalize patch outcomes into right/wrong/total metrics",
            "extract per-agent trajectory token and call telemetry",
        ),
        promotion_priority="p1",
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
        promotion_requirements=(
            "map AgentBench OS/WebShop/Mind2Web environments to matrix cells",
            "add an OpenCode-compatible harness alongside ElizaOS",
            "normalize environment success rates into comparable outcome rows",
        ),
        promotion_priority="p1",
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
        promotion_requirements=(
            "select coding subtasks for the code-agent matrix",
            "run both adapters through the same multi-turn tool protocol",
            "surface turn-k success and token telemetry in matrix results",
        ),
        promotion_priority="p1",
    ),
    CodeAgentBenchmark(
        benchmark_id="app_eval_coding",
        status=DEFERRED_STATUS,
        domains=("coding",),
        reason=(
            "App Eval has coding tasks, but they are heuristic app-agent "
            "regression checks without an OpenCode-comparable adapter path."
        ),
        promotion_requirements=(
            "decide whether heuristic app-agent scoring is acceptable for code-agent release gates",
            "add OpenCode execution path or keep as non-release advisory only",
            "normalize coding-task scores into right/wrong/total if promoted",
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
        promotion_requirements=(
            "wrap HumanEval prompts as workspace tasks for code agents",
            "execute generated code in the same sandbox for both adapters",
            "record pass/fail and per-call telemetry per task",
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
        status=DEFERRED_STATUS,
        domains=("coding", "terminal"),
        reason=(
            "The local OpenClaw benchmark contains coding-assistant and "
            "OpenCode-plugin tasks, but it is not yet normalized into the "
            "ElizaOS/OpenCode matrix artifact schema."
        ),
        promotion_requirements=(
            "map standard coding tasks to matrix benchmark cells",
            "run ElizaOS and OpenCode through the same isolated task harness",
            "emit right/wrong/total plus token and LLM-call telemetry per task",
        ),
        promotion_priority="p1",
    ),
    CodeAgentBenchmark(
        benchmark_id="claw_eval",
        status=DEFERRED_STATUS,
        domains=("coding", "browser", "computer-use", "agent"),
        reason=(
            "Claw-Eval includes webpage generation, multimodal, and "
            "real-world autonomous-agent tasks, but its Pass^3/trial runner "
            "and judge flow are not adapted for ElizaOS/OpenCode head-to-head rows."
        ),
        promotion_requirements=(
            "select coding/browser/computer-use task slices from Claw-Eval",
            "add ElizaOS/OpenCode execution configs with matched trials",
            "normalize Pass^3 and judge outcomes into comparable matrix rows",
        ),
        promotion_priority="p1",
    ),
    CodeAgentBenchmark(
        benchmark_id="qwen_claw_bench",
        status=DEFERRED_STATUS,
        domains=("coding", "terminal", "computer-use", "agent"),
        reason=(
            "QwenClawBench exercises workspace, system-operations, data, "
            "security, and orchestration tasks through OpenClaw containers, "
            "but only OpenClaw model configs are wired today."
        ),
        promotion_requirements=(
            "add ElizaOS and OpenCode agents to the QwenClawBench runner config",
            "capture transcript, anomaly, score, token, and LLM-call artifacts per run",
            "aggregate repeated runs into stable head-to-head matrix outcomes",
        ),
        promotion_priority="p1",
    ),
    CodeAgentBenchmark(
        benchmark_id="clawbench",
        status=DEFERRED_STATUS,
        domains=("terminal", "browser", "computer-use", "tool-use"),
        reason=(
            "ClawBench is a deterministic multi-tool workspace benchmark with "
            "exec, read, and web tools, but it targets OpenClaw scenarios rather "
            "than the ElizaOS/OpenCode matrix adapters."
        ),
        promotion_requirements=(
            "map ClawBench scenarios to matrix cells",
            "add OpenCode and ElizaOS drivers against the same mock tools",
            "convert rubric points into right/wrong/total and trajectory telemetry",
        ),
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
