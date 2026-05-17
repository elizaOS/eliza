# NL2Repo (NL2Repo-Bench) Integration Notes

> **Canonical source:** [github.com/multimodal-art-projection/NL2RepoBench](https://github.com/multimodal-art-projection/NL2RepoBench)
> **Paper:** [arXiv:2512.12730](https://arxiv.org/abs/2512.12730) — "NL2Repo-Bench: Towards Long-Horizon Repository Generation Evaluation of Coding Agents" (Ding et al., Dec 2025)
> **Confidence:** **High.** The published numbers cited by the user (15.5 – 43.2 average test pass-rate across SOTA agents) match the paper's claim "even the strongest agents achieve below 40% average test pass rates". The paper's GitHub repo is the only public NL2Repo dataset; no other candidate exists.

## 1. What NL2Repo evaluates

NL2Repo-Bench measures **long-horizon, 0-to-1 repository generation**. An agent is given:

- A single natural-language requirements document (`start.md`).
- An empty workspace.

It must autonomously design the architecture, manage dependencies, implement multi-module logic, and produce a **fully installable, runnable Python library**. The benchmark targets coding **agents** (multi-step tool-using agents), not single-turn completion models.

## 2. Dataset

- **104 Python library reproduction tasks** (the repo ships 105 task directories, but `more-Itertools` is a case-insensitive duplicate of `more-itertools` and should be ignored; `config.json` enumerates the canonical 104).
- **Categories:** System tools, data processing, testing frameworks, networking, ML, web/HTTP, parsing, CLI, async I/O, security, etc.
- **Size range:** roughly 300 – 120,000 LOC per target library.
- **Difficulty:** Easy / Medium / Hard, see `test_files/task_difficulty.csv`.
- **Avg input length:** ~18,800 tokens per `start.md`.

Each task directory under `test_files/<task>/` contains:

| File | Purpose |
| --- | --- |
| `start.md` | Natural-language requirements doc (the agent's only input). |
| `test_case_count.txt` | Total upstream-suite test case count, used as the denominator for the pass-rate score. |
| `test_commands.json` | JSON array of shell commands to install + run the upstream test suite inside the eval container (e.g. `["pip install -e .", "pytest --continue-on-collection-errors tests"]`). |
| `test_files.json` | JSON array of paths (`tests/` directories or specific test files) that the harness **deletes from the agent's workspace before testing** — the agent must not see ground-truth tests; they are re-mounted from the canonical eval image. |

The upstream test suites themselves are **not in this repo**. They live inside per-task Docker base images published at `ghcr.io/multimodal-art-projection/nl2repobench/<task>:1.0`. The harness builds a per-run image FROM that base image, COPYs the agent's generated workspace into `/workspace`, then runs `test_commands.json` against it.

## 3. Scoring

**Functional, test-based.** No LLM-judge.

For each task:

1. Agent produces a workspace from `start.md`.
2. Harness strips packaging files and any ground-truth test directories the agent created.
3. Harness builds a Docker image from `ghcr.io/.../<task>:1.0` + the agent's workspace.
4. Harness runs `test_commands.json` (typically `pip install -e .` followed by `pytest`).
5. Harness parses pytest output for `N passed` / `N failed` / `N error`.
6. **Score = passed / test_case_count**, clamped to `[0, 1]`. See `openhands/post_processor.py::analyze_pytest_results`.

Aggregate benchmark score = mean pass-rate across all 104 tasks (this is the 15.5 – 43.2 range in the user's table — values are percent pass-rate × 100).

A task scores 0 if the build fails, install fails, or pytest cannot collect.

## 4. Reference runner interface

The shipped runner targets **OpenHands** in headless batch mode:

- Entry: `main.py` → `openhands.openhands_app.start_openhands(config)`.
- Config: `config.json` with `startPro: [{ moduleName, baseUrl, sk, proNameList: [...] }]` and `max_pool_size` (concurrency).
- Per task, the runner:
  1. Creates `workspaces/<task>_bo1/workspace/`.
  2. Copies `test_files/<task>/start.md` into it.
  3. Renders `template/config.template.toml` with the model creds + workspace mount path.
  4. Launches `docker.all-hands.dev/all-hands-ai/openhands:0.56` headless, which spawns its own runtime container (`docker.all-hands.dev/all-hands-ai/runtime:0.56-nikolaik`) and prompts the agent with: *"According to the start.md in the workspace, implement the entire project as per the requirements specified in the document…"*
  5. Waits for the OpenHands container to exit (auto-removes).
  6. Runs `post_process_task` — strips packaging + test files, builds the eval image, runs `test_commands.json`, parses pytest output, writes `result/<task>_bo1.json`.

The runner is OpenHands-specific. For our adapters, only steps 1–2 (prompt construction) and 6 (scoring) are reusable; the agent invocation in between is replaced.

## 5. Sandbox / environment requirements

- **Docker required.** Both the agent and the evaluator run in containers. There is no native-host execution mode.
- **Docker-in-Docker:** OpenHands containers need `/var/run/docker.sock` bind-mounted so they can spawn runtime containers. For our adapters this is only relevant if we keep OpenHands as one of the harness backends; otherwise we only need outer Docker for the evaluator.
- **Per-task base images:** `ghcr.io/multimodal-art-projection/nl2repobench/<task>:1.0` × 104 tasks. These ship the upstream test suite and the exact Python environment the upstream library expects. Pulling all 104 is multi-GB; pull lazily by task.
- **Python 3.12** in the default runtime; some tasks pin different Python versions via their base image.
- **Network:** Required during agent execution (LLM API, pip install). Eval phase needs network for `pip install -e .` unless we pre-cache wheels in a side image.
- **Disk:** `workspaces/` and `result/` grow per task; `workspaces/<task>_bo1.zip` snapshots are kept for audit.
- **No GPU.**

## 6. Integration plan for our three adapters

Our `packages/benchmarks/` has three adapters: `eliza-adapter`, `hermes-adapter`, and the implicit third (OpenHands-style baseline, reused from upstream). NL2Repo plugs in cleanly because the **agent invocation** is the only part that varies — task loading and scoring are model-agnostic.

### Shared harness (new, recommended)

Build a thin `nl2repo_harness/` Python module that exposes:

```python
class NL2RepoTask:
    name: str                # e.g. "aiofiles"
    difficulty: Level        # Easy | Medium | Hard
    prompt_md_path: Path     # test_files/<name>/start.md
    test_commands: list[str] # from test_commands.json
    strip_paths: list[str]   # from test_files.json
    test_case_count: int     # from test_case_count.txt
    eval_image: str          # ghcr.io/.../<name>:1.0

def load_tasks(root: Path) -> list[NL2RepoTask]: ...
def score_workspace(task: NL2RepoTask, workspace: Path) -> Score: ...
```

`load_tasks` replaces `test_data_service.py` (cleaner: no globals, no `more-Itertools` dup). `score_workspace` is `post_processor.post_process_task` minus the OpenHands coupling — it takes a finished workspace, strips packaging + test files, builds the eval image, runs `test_commands`, parses pytest output, returns a typed score.

Each adapter then implements one method:

```python
def run_task(task: NL2RepoTask, workspace: Path) -> None: ...
```

…which prompts its agent with `task.prompt_md_path` and lets the agent populate `workspace/`. The harness handles everything else.

### Per-adapter wiring

1. **`eliza-adapter`** — spawn an Eliza coding sub-agent (Claude / Codex / OpenCode / Pi, per existing `coding-agent` skill) in `workspace/`, with `start.md` copied in and a prompt equivalent to OpenHands's *"implement the entire project per start.md, ensuring it runs in cwd"*. Use the existing PTY + telemetry hooks. Cap iterations / wall-clock budget per task (OpenHands default is 500 iterations). Token-budget cap is critical given ~18.8k input tokens × hundreds of turns.

2. **`hermes-adapter`** — wrap a plain non-Eliza agent (single-process REPL or function-calling loop) the same way. Same prompt, same `workspace/` mount.

3. **OpenHands baseline** — keep the upstream `openhands/openhands_app.py` flow as an optional baseline backend. Useful to reproduce the paper's numbers (15.5 – 43.2 range) before claiming improvements from our adapters.

### Concurrency

Each task is independent and dockerized end-to-end, so a thread/process pool over tasks works (the upstream runner uses `ThreadPoolExecutor` with `max_pool_size`). Plan ~5–10 GB disk + multiple Docker images in flight; default to `max_pool_size = 4` in our harness.

### Result format

Match the existing `benchmark_results/` conventions in `packages/benchmarks/`: one JSON file per (adapter × model × task) with `{task, score, passed, failed, errors, total, duration_s, status, log_path}`. Aggregate to `summary.json` with per-difficulty and overall mean pass-rate so we can publish numbers comparable to the paper's table.

## 7. What was kept vs. stripped from the clone

Kept (all needed for integration reference + dataset):

- `test_files/` — the 104 task specs (`start.md`, `test_commands.json`, `test_files.json`, `test_case_count.txt`, `task_difficulty.csv`). **This is the dataset.**
- `openhands/`, `docker_self/`, `test_data_service.py`, `post_processor.py` — reference runner. Useful as ground truth for what scoring must do; not loaded at runtime by our adapters.
- `template/config.template.toml`, `config.json`, `main.py`, `only_test.py`, `tests/`, `logging_config.py`, `requirements.txt`, `readme.md` — original entry points + docs.

Stripped at clone time:

- `.git/` (shallow clone, history not needed).
- `.DS_Store`.
- All `__pycache__/` + `.pyc`.

Nothing else is over 10 MB. Total clone footprint: ~9.5 MB.

Not stripped but noted:

- `test_files/more-Itertools/` is a case-insensitive macOS duplicate of `test_files/more-itertools/`. Ignore at load time — the canonical task list is `config.json::startPro[0].proNameList` (104 entries).

## 8. Open questions / non-fabricated risks

- **Pulling 104 base images** at first run is heavy (multi-GB). We should support a lazy pull + retain policy. Confidence: high — confirmed by `post_processor.create_dockerfile` referencing `ghcr.io/multimodal-art-projection/nl2repobench/<task>:1.0`.
- **Best-of-N / `bo_size`:** upstream supports a `bo_size` field (`<task>_bo1`, `<task>_bo3`, ...) but the released runner pins `bo_size=1`. The paper may report best-of-N for some configurations; verify before claiming parity.
- **Test-command stability:** all 104 task `test_commands.json` files inspected so far are simple `pip install -e .` + `pytest …` pairs, but they're authored per task. Treat the JSON as opaque and pass through verbatim.
- **No LLM-judge fallback.** If pytest cannot collect (e.g. `__init__.py` import error), score is 0 even if the code is partially correct. This is intentional in the paper; our adapters must accept it.
