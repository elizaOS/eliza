# SkillsBench Integration Notes

Snapshot of the upstream [benchflow-ai/skillsbench](https://github.com/benchflow-ai/skillsbench) repo, cleaned for local integration into the Milady benchmarks suite.

## What is SkillsBench?

A gym-style benchmark for measuring how well agentic LLM harnesses leverage **skills** (modular folders of `SKILL.md` + scripts + resources). Each task ships a Dockerized environment with a `tests/` harness; the agent is evaluated against outcome-based assertions.

Upstream uses the BenchFlow SDK (`uv run bench …`) to orchestrate Docker / Daytona sandboxes per trial.

## Repo Layout (post-strip)

```
skillsbench/
├── AGENTS.md                # Upstream contributor instructions (kept)
├── CONTRIBUTING.md          # Full task-authoring rubric
├── MAINTAINER.md
├── README.md
├── LICENSE                  # Apache-2.0
├── pyproject.toml           # uv project, py>=3.12, depends on benchflow (git main)
├── docs/                    # ~10MB — harness invocation surface audit, skills research
│   ├── harnesses/
│   ├── skills-research/     # State-of-skills analysis, categories, dedupe
│   ├── instruction-guidelines.md
│   └── unit-test-guidelines.md
├── experiments/             # ~12MB — config sweeps + metrics dashboard (React/Vite)
│   ├── configs/             # daytona-with-skills.yaml, daytona-without-skills.yaml, etc.
│   ├── metrics-dashboard/   # node dashboard for analyzing jobs/
│   ├── sanity-tasks/
│   └── scripts/             # run_benchflow_integration.py, run_opencode_daytona_ablation.py
└── tasks/                   # ~242MB — 62 task directories
```

Stripped on clone: `.git`, `.github`, `.claude`, `.agents`. Disk: 263MB total.

## Task Count and Format

- **62 default runnable tasks** in `tasks/` (upstream AGENTS.md states 91 total; this snapshot has 62; the rest live in `tasks_excluded/` upstream and were not pulled in this clone — none of `tasks_excluded/` is included).
- Each task directory follows a strict layout (also documented in upstream AGENTS.md):

```
tasks/<task-id>/
  instruction.md          # Human-written, outcome-focused. No skill hints.
  task.toml               # version, [metadata], [verifier].timeout_sec, [agent].timeout_sec,
                          # [environment] cpus / memory_mb / storage_mb / build_timeout_sec
  environment/
    Dockerfile
    skills/<skill-name>/  # Domain skills surfaced to the agent under test
    <data files>
  solution/
    solve.sh              # Oracle (human-written; computes, not hardcodes)
  tests/
    test.sh               # Pytest runner that writes reward.txt
    test_outputs.py       # Outcome-based assertions
```

- **146 unique per-task skill directories** mounted under `tasks/*/environment/skills/`. Skills are intended to be generalizable and reused across tasks (e.g. `ffmpeg`, `csv-processing`, `docx`, `browser-testing`).

## Scoring Methodology

Per-trial reward is a float in `[0.0, 1.0]` written by `tests/test.sh` into `reward.txt`. Upstream config defaults:

- `n_attempts: 5` — each task is run **5 times per (agent, model)** combination.
- Final reward per (task, agent, model) is the **mean over the 5 attempts** (`uv run bench metrics jobs/<run-dir>` aggregates).
- There is no upstream concept called "Avg5" in the repo as named — the `5` is the trial count knob. The reported metric is the arithmetic mean reward over those `n_attempts=5` trials, optionally segmented by task category.
- Categories (from `task.toml` `[metadata].category`) include: engineering, scientific, finance, ops, etc. Categorical means are useful when building a small averaged headline metric.

## Sandbox Dependency

- Default backend: **Daytona** (`environment.type: daytona` in `experiments/configs/daytona-*.yaml`). Daytona spins ephemeral Linux sandboxes per trial.
- Local Docker is also supported (`uv run bench eval create -t tasks/<id> -a oracle` runs in-process / against local Docker, see `experiments/README.md`).
- `experiments/scripts/run_benchflow_integration.py` is the integration sweep runner with `--backend daytona`, `--concurrency`, `--env-file`.
- Daytona auth is required for the cloud sandbox path; without Daytona, run locally with Docker.

## With-Skills vs Without-Skills

Two parallel datasets in upstream:

- `tasks/` — environments with `environment/skills/` populated (agent sees skills).
- `tasks-no-skills/` — same tasks but skills stripped out (control). Upstream config: `daytona-without-skills.yaml` points `datasets[*].path` to `tasks-no-skills`. **This snapshot does NOT include `tasks-no-skills/`.** To run the ablation you must either pull it from upstream or strip `environment/skills/` programmatically.

The headline measurement upstream reports is the per-(agent, model) delta between with-skills and without-skills mean reward.

## Estimated Run Cost (cerebras gpt-oss-120b)

Best-effort estimate from task TOMLs:

- Typical `task.toml` has `[verifier].timeout_sec = 600–900` and `[agent].timeout_sec = 600–900`.
- On a fast inference path (cerebras gpt-oss-120b, ~2000 tok/s), agents rarely use the full window; representative wallclock per trial: **3–8 minutes**, dominated by sandbox boot + verifier.
- With `n_attempts=5` and 62 tasks: **~15–40 trial-hours per (agent, model)** end-to-end serial. Parallelizable up to the concurrency cap (`n_concurrent_trials: 600` in upstream config, but Daytona quota will be the bottleneck).

## Access Gating

| Surface | Requirement |
|---|---|
| Daytona sandboxes | Daytona account + API token (env var per BenchFlow SDK) |
| Local Docker | Docker daemon only |
| BenchFlow SDK | `uv sync --locked`; pulls from `github.com/benchflow-ai/benchflow#main` |
| Anthropic agents | `ANTHROPIC_API_KEY` |
| OpenAI / codex agents | `OPENAI_API_KEY` |
| Gemini agents | `GEMINI_API_KEY` or Gemini CLI subscription auth |
| Vertex AI Claude (Opus/Sonnet/Haiku 4.x) | Vertex AI auth |
| Judge LLM | **No judge LLM.** Scoring is entirely deterministic via `tests/test_outputs.py` pytest assertions on agent outputs. |

## Integration Plan for Milady Adapters

Mirror the pattern at `/Users/shawwalters/eliza-workspace/milady/eliza/packages/benchmarks/eliza-adapter/eliza_adapter/bfcl.py`. That file defines an agent class (`ElizaBFCLAgent`) with the duck-typed interface a runner expects:

```python
async def initialize() -> None
async def setup_test_case(test_case) -> None        # optional
async def query(test_case, timeout_ms=None) -> tuple[...]
async def close() -> None
@property model_name -> Optional[str]
```

For SkillsBench, the analogous interface is BenchFlow's agent SDK (a `claude-agent-acp` / `codex-acp` / `gemini`-style class). The adapter wraps the elizaOS runtime so BenchFlow can drive it like any other harness.

### 1. `eliza-adapter/eliza_adapter/skillsbench.py`

- Subclass / register a BenchFlow agent (look at `libs.terminus_agent.agents.terminus_2.harbor_terminus_2_skills:HarborTerminus2WithSkills` in upstream configs for the shape).
- The agent receives:
  - working directory inside the sandbox containing `environment/skills/`
  - `instruction.md` text
  - a tool surface (shell, file I/O) the harness mediates
- Implementation: route turns through the Eliza TS benchmark bridge (`ElizaClient` — same client `bfcl.py` uses). The bridge already exposes a `USE_SKILL` action; mount `environment/skills/` into the runtime workspace before the first turn.
- Trajectory export hooks omitted — the TS runtime logs server-side, identical to bfcl.

### 2. `hermes-adapter/hermes_adapter/skillsbench.py`

- Wrap the Hermes tool-calling agent. Skills are surfaced as system-prompt-injected SKILL.md blocks (Hermes has no native `invoke_skill` tool — closest analog is `codex` per `docs/harnesses/skill-invocation-surfaces.md`: inject `<skill>` body fragments on activation).
- Discovery: walk `environment/skills/*/SKILL.md`, inject descriptions into the system prompt, switch to full body on keyword/name match.

### 3. `openclaw-adapter/openclaw_adapter/skillsbench.py`

- OpenClaw has native skill support. Mount `environment/skills/` into the workspace, let the runtime's skill loader discover them. Forward turns + tool results to/from BenchFlow.

### Shared utilities (suggested)

- `skillsbench_common.py` — code to read `task.toml`, parse `instruction.md`, locate `environment/skills/`, and translate BenchFlow's per-trial context into the adapter's prompt format. Single source of truth shared by all three adapters.

### Runner integration

- Mirror `experiments/scripts/run_benchflow_integration.py` as `packages/benchmarks/skillsbench/run.py` in the Milady tree, parameterized by `--adapter eliza|hermes|openclaw` and `--model …`.
- Results land in `~/.milady/benchmark_results/skillsbench/<run-id>/` using the same `result.json` + `trajectory.json` + `reward.txt` layout the rest of `benchmark_results/` uses.

## Verification Steps Before First Run

1. `cd skillsbench && uv sync --locked` — pulls BenchFlow main.
2. `uv run bench tasks check experiments/sanity-tasks/hello-world` — sanity.
3. `uv run bench eval create -t tasks/3d-scan-calc -a oracle` — runs the human oracle against a real task; should score 1.0.
4. Wire up one adapter (`eliza-adapter` first; bfcl.py is the closest precedent) and run `-a eliza-skillsbench -m gpt-oss-120b` against a single task.
5. Only after a single trial passes end-to-end, scale to the full 62-task sweep.

## Known Risks / Open Questions

- Snapshot has 62 tasks; upstream README claims "91 task definitions" and `experiments/README.md` references "87 default included tasks". Re-clone if a fuller dataset is needed.
- `tasks-no-skills/` is not present locally — the with/without skills ablation requires either a separate upstream pull or a programmatic strip.
- `experiments/configs/daytona-*.yaml` reference Vertex AI Claude models and a specific GCP project layout; rewrite the agent list before reuse.
- BenchFlow tracks `main` branch — pin a commit (`uv lock --upgrade-package benchflow`) before running comparative experiments.
