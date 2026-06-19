# OSWorld — Agent Guide

Multimodal desktop agent benchmark: 369 real computer tasks spanning Chrome,
LibreOffice, GIMP, VS Code, and more — arXiv:2404.07972. Vendored from
[xlang-ai/OSWorld](https://github.com/xlang-ai/OSWorld) with an elizaOS
TypeScript bridge agent layered on top. Registered in the suite registry as
`osworld`.

## Run

```bash
# Direct — single task via Docker provider (from this directory)
python scripts/python/run_multienv_eliza.py \
    --provider_name docker \
    --observation_type screenshot_a11y_tree \
    --model openai/gpt-oss-120b \
    --max_steps 15 \
    --result_dir ./results/eliza \
    --task_id 030eeff7-b492-4218-b312-701ec99ee0cc

# Direct — all tasks, 5 parallel VMs
python scripts/python/run_multienv_eliza.py \
    --provider_name docker \
    --observation_type screenshot_a11y_tree \
    --model openai/gpt-oss-120b \
    --max_steps 15 \
    --num_envs 5 \
    --result_dir ./results/eliza

# VMware on macOS
python scripts/python/run_multienv_eliza.py \
    --provider_name vmware \
    --path_to_vm ~/Virtual\ Machines.localized/Ubuntu.vmwarevm/Ubuntu.vmx \
    --observation_type screenshot_a11y_tree \
    --model openai/gpt-oss-120b \
    --max_steps 15 \
    --result_dir ./results/eliza

# Through the suite orchestrator
python -m benchmarks.orchestrator run --benchmarks osworld --provider <p> --model <m>
```

## Smoke test (no VM required)

```bash
# Runs one synthetic in-process task; does not start VMs or the Eliza server
python scripts/python/run_multienv_eliza.py \
    --provider_name docker \
    --observation_type screenshot_a11y_tree \
    --model openai/gpt-oss-120b \
    --max_steps 1 \
    --dry_run \
    --result_dir /tmp/osworld-smoke

# Via orchestrator (passes extra.dry_run=true)
python -m benchmarks.orchestrator run --benchmarks osworld --provider mock --model mock \
    --extra '{"dry_run": true}'
```

## Test the harness

```bash
# From the OSWorld directory
pip install -e .
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `scripts/python/run_multienv_eliza.py` | Primary entrypoint (elizaOS bridge agent, multi-env) |
| `run.py` | Legacy single-env runner (almost deprecated) |
| `desktop_env/` | VM provider abstractions (Docker, VMware, VirtualBox, AWS, Azure, GCP) |
| `desktop_env/evaluators/` | Per-app task evaluators (Chrome, GIMP, LibreOffice, VLC, VS Code, etc.) |
| `mm_agents/` | Reference agent implementations (upstream; not used by elizaOS path) |
| `evaluation_examples/` | 369 task config JSON files, organised by domain |
| `tests/test_run_multienv_eliza.py` | pytest suite for the elizaOS bridge harness |
| `lib_run_single.py` | Per-task execution loop (shared by all runners) |
| `lib_results_logger.py` | Structured result/error logging helpers |
| `pyproject.toml` | Package metadata and dependencies |

## Notes

- Requires a VM provider: Docker (with KVM), VMware, or VirtualBox. No API
  keys are needed for the benchmark itself, but the agent model needs an LLM key.
- The elizaOS bridge routes all decisions through the TypeScript benchmark
  server (`packages/app-core/src/benchmark/server.ts`). Set `ELIZA_BENCH_URL`
  to skip auto-starting it and point at an already-running instance.
- Results write to `./results/eliza/` by default (gitignored). The orchestrator
  writes to its own `output_dir` and locates `osworld-eliza-results-*.json`.
- Scored by `_score_from_osworld_json` in `registry/scores.py`.
- Observation types: `screenshot`, `a11y_tree`, `screenshot_a11y_tree` (default), `som`.
- Full setup (VM provisioning, GCP auth, proxy): [SETUP_GUIDELINE.md](SETUP_GUIDELINE.md).
- Upstream paper and data: [README.md](README.md).
