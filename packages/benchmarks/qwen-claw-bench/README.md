<div align="center">

<img src="imgs/qwen-capybara.png" width="400" alt="QwenClawBench Logo">

# QwenClawBench

> **A real-user-distribution benchmark for OpenClaw agents — built for robust evaluation at scale**

English | [中文](README_CN.md)

<img src="imgs/qwen-logo.png" height="55" alt="Qwen Logo">
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
<img src="imgs/alibaba-data-logo.png" height="50" alt="AlibabaData Logo">

<br>

[![Leaderboard](https://img.shields.io/badge/leaderboard-View-blue)](https://skylenage-ai.github.io/QwenClawBench-Leaderboard/)
[![HuggingFace](https://img.shields.io/badge/huggingface-Dataset-yellow)](https://huggingface.co/datasets/skylenage-ai/QwenClawBench)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Tasks](https://img.shields.io/badge/tasks-100-orange)](#tasks)
[![Version](https://img.shields.io/badge/version-1.1-purple)](#future-work)

</div>

QwenClawBench is a real-user-distribution benchmark for evaluating [OpenClaw](https://github.com/openclaw/openclaw) agents. It was originally built as an internal benchmark during the development of [Qwen3.6-Plus](https://qwen.ai/blog?id=qwen3.6), and has since been optimized and open-sourced.

## Why QwenClawBench?

QwenClawBench contains **100 tasks** across **8 core domains**, each with an isolated simulated workspace. Domains are carefully chosen to reflect real OpenClaw usage patterns, and assets are designed to simulate authentic working scenarios.

Reproducing robust large-scale evaluations on OpenClaw is nontrivial, as results depend heavily on infrastructure reliability. We have built in the following features to address this:

- **Docker Isolation**: Each task runs in a dedicated Docker container, ensuring a consistent and reproducible environment
- **Concurrent Execution**: Tasks run in parallel across multiple containers, significantly reducing total evaluation time
- **Anomaly Detection**: Infrastructure failures (API errors, container crashes, timeouts) are flagged explicitly rather than silently folded into scores, so you always know which results to trust
- **Resumable Runs**: Interrupted runs can be resumed from where they left off, skipping already-completed healthy tasks to obtain stable results

## Quick Start

### Requirements

- Python >= 3.10
- Docker

**Install dependencies:**
```bash
pip install pyyaml>=6.0.1 tqdm>=4.0
```

**Pull the OpenClaw Docker image:**
```bash
docker pull ghcr.io/openclaw/openclaw:main
```

### Configuration

1. Place the benchmark data under `data/<dataset_name>/` (default: `qwenclawbench-v1.1-100`), with the following structure:

```
data/qwenclawbench-v1.1-100/
├── tasks/       # task_*.md files
└── assets/      # per-task asset directories
```

2. Configure the model provider in `openclaw_config/openclaw.json`. See `openclaw_config/openclaw.json.example` for reference, or copy your existing `~/.openclaw/openclaw.json`.

3. Set API credentials in `openclaw_config/.env`. See `openclaw_config/.env.example` — required variables are marked in the example file.

### Run Evaluation

```bash
# Set variables
DATASET="qwenclawbench-v1.1-100"
RUNS=3
CONCURRENCY=10
LOGDIR="logs/$DATASET"

# Run evaluation: 10 parallel containers, 3 runs per task (scores are averaged)
./scripts/run.sh --model dashscope/qwen3.6-plus \
    --dataset $DATASET \
    --runs $RUNS \
    --concurrency $CONCURRENCY \
    --output-dir ./results/$DATASET/qwen3.6-plus \
    --log-file $LOGDIR/qwen-3.6-plus.log
```

Interrupted runs can be resumed without re-running completed tasks. Anomalous runs can also be selectively retried:

```bash
# Resume an interrupted run — use the same --output-dir as the original run
./scripts/run.sh --model dashscope/qwen3.6-plus \
    --dataset $DATASET \
    --runs $RUNS \
    --concurrency $CONCURRENCY \
    --output-dir ./results/$DATASET/qwen3.6-plus \
    --log-file $LOGDIR/qwen-3.6-plus.log

# Resume and rerun all anomalous tasks
./scripts/run.sh --model dashscope/qwen3.6-plus \
    --dataset $DATASET \
    --runs $RUNS \
    --concurrency $CONCURRENCY \
    --output-dir ./results/$DATASET/qwen3.6-plus \
    --log-file $LOGDIR/qwen-3.6-plus.log \
    --rerun-anomalous

# Force a clean start, discarding any existing results
./scripts/run.sh --model dashscope/qwen3.6-plus \
    --dataset $DATASET \
    --runs $RUNS \
    --concurrency $CONCURRENCY \
    --output-dir ./results/$DATASET/qwen3.6-plus \
    --log-file $LOGDIR/qwen-3.6-plus.log \
    --no-resume
```

## Tasks

### Task Category Distribution

QwenClawBench emphasizes **realism** and **complexity**, covering 100 tasks across 8 domains.

| Category | Count | Description |
|----------|-------|-------------|
| Workflow and Agent Orchestration | 21 | Workflow orchestration, skill creation, cron jobs, multi-agent coordination |
| System Operations and Administration | 20 | System ops, environment configuration, troubleshooting, workspace management |
| Knowledge and Memory Management | 15 | Knowledge base construction, memory system design, document management, context retrieval |
| Finance and Quantitative Trading | 10 | Quant strategy backtesting, arbitrage monitoring, trade analysis, position management |
| Data Analysis and Modeling | 10 | Statistical analysis, data processing, quality auditing, regression modeling |
| Security and Vulnerability Management | 9 | Security auditing, credential management, injection defense, privacy compliance |
| Communication and Scheduling | 8 | Message notifications, schedule planning, timed reminders, task scheduling |
| Research and Information Retrieval | 7 | Competitive analysis, literature retrieval, technical research, SEO keyword research |

### Task Structure

Each task is a Markdown file (`data/tasks/task_*.md`) with a **YAML frontmatter** header and structured **body sections**.

**Frontmatter Metadata:**

| Field | Description |
|-------|-------------|
| `id` | Unique task identifier |
| `name` | Short task title |
| `category` / `subcategory` | Task category and subcategory |
| `grading_type` | Scoring mode: `automated` (pure automated), `llm_judge` (pure LLM review), `hybrid` (combined) |
| `grading_weights` | Weight allocation between automated and LLM judge scoring in hybrid mode |
| `timeout_seconds` | Task execution timeout |
| `workspace_files` | Initial workspace file mappings |

**Body Sections:**

| Section | Content |
|---------|---------|
| `## Prompt` | User instructions for the agent — the specific task the agent needs to complete |
| `## Expected Behavior` | Detailed description of expected behavior, also serves as reference context for the LLM judge |
| `## Grading Criteria` | Scoring checklist (`- [ ]` format) |
| `## Automated Checks` | Automated scoring code (Python), defines a `grade(transcript, workspace_path) -> dict` function |
| `## LLM Judge Rubric` | LLM judge scoring dimensions with detailed descriptions for each score tier |

**Asset Directories:**

Each task has a corresponding directory under `data/assets/<task_id>/` containing the initial workspace files (code, configs, data, logs, etc.). These files are copied into the Docker container's workspace before the task runs.

## Scoring Mechanism

QwenClawBench supports three scoring modes: `automated`, `llm_judge`, and `hybrid`.

**Automated:**
A Python function `grade(transcript, workspace_path)` embedded in the task definition performs deterministic, rule-based checks on the agent's deliverables — verifying output files, command results, and workspace state. The final score is the mean across all checked dimensions.

**LLM Judge:**
A judge model (claude-opus-4.5 by default) reviews the agent's action transcript and scores performance across multiple rubric dimensions, each from 0.0 to 1.0. The final score is a weighted average across dimensions.

**Hybrid:**

Both methods run independently and are combined via `grading_weights`. Typically, automated checks verify concrete deliverables against ground-truth rules, while the LLM judge evaluates the quality and coherence of the agent's reasoning trajectory.

In practice, we observed that on some tasks, agents failed to produce correct deliverables yet still received high LLM judge scores. This occurs because LLM judges primarily assess trajectory quality and are inherently less stable — and more susceptible to being hacked by agents that produce fluent but incorrect outputs. To prevent this, we apply **penalized scoring**:
$$
\text{score} = w_\text{auto} \cdot s_\text{auto} + w_\text{llm} \cdot s_\text{llm} \cdot \mathbb{1}[s_\text{auto} \geq 0.75]
$$

When the automated score falls below 0.75, the LLM judge contribution is zeroed out — the assumption being that a model that failed basic deliverable checks should not receive credit from the judge regardless of how well it reasoned. Use `--simple-scoring` to disable this and fall back to a plain weighted average.

## Project Structure

```
QwenClawBench/
├── README.md
├── scripts/
│   ├── benchmark.py          # Main evaluation entry point
│   ├── lib_tasks.py          # Task loading and parsing
│   ├── lib_grading.py        # Scoring engine (automated + LLM judge + hybrid)
│   ├── lib_docker.py         # Docker container management
│   ├── lib_agent.py          # OpenClaw agent interaction
│   ├── lib_anomalies.py      # Anomaly detection
│   └── run.sh                # Helper run script
├── openclaw_config/
│   ├── openclaw.json         # OpenClaw model and provider configuration
│   └── .env                  # API credentials (should not be committed to VCS)
└── data/
    └── <dataset>/
        ├── tasks/            # 100 task_*.md task definition files
        └── assets/           # 100 task asset directories (initial workspace files)
```

## Future Work

We will continuously maintain this repository and leaderboard, and plan to expand the benchmark in future versions with:

- Long-horizon tasks requiring complex memory and skill chaining
- Broader coverage of productivity workflows
- Scoring mechanism that more faithfully reflects real-world task value
- Richer real-world environments (mock servers, complex file systems, etc.)
- Simulated user interaction

## Acknowledgments

QwenClawBench is built on top of the [PinchBench](https://github.com/pinchbench/skill) framework. We also acknowledge other open-source contributions from the community, such as [Claw-Eval](https://github.com/claw-eval/claw-eval), [ZClawBench](https://huggingface.co/datasets/zai-org/ZClawBench), and [WildClawBench](https://github.com/InternLM/WildClawBench).

## Citation

If you use QwenClawBench in your research, please cite:

```bibtex
@misc{qwenclawbench1.1,
    title = {{QwenClawBench}: Real-user-distribution benchmark for OpenClaw agents},
    url = {github.com/SKYLENAGE-AI/QwenClawBench},
    author = {{Qwen Team} and {Alibaba Data}},
    month = {April},
    year = {2026}
}
```

## License

MIT — see [LICENSE](LICENSE) for details.
