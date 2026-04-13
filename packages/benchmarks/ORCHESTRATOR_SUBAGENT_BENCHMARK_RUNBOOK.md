# Orchestrator Subagent Benchmark Runbook

## Prerequisites
- Python environment with benchmark dependencies installed
- Optional API keys for your model/provider (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`)
- Optional `HF_TOKEN` for official GAIA dataset access

## 1) Verify benchmark IDs
```bash
python -m benchmarks.orchestrator list-benchmarks
```

Expected IDs include:
- `swe_bench_orchestrated`
- `gaia_orchestrated`
- `orchestrator_lifecycle`

## 2) Run SWE matrix (code)
```bash
python -m benchmarks.orchestrator run \
  --benchmarks swe_bench_orchestrated \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --extra '{"per_benchmark":{"swe_bench_orchestrated":{"matrix":true,"max_instances":3,"no_docker":true,"strict_capabilities":true}}}'
```

## 3) Run GAIA matrix (research)
```bash
python -m benchmarks.orchestrator run \
  --benchmarks gaia_orchestrated \
  --provider groq \
  --model qwen/qwen3-32b \
  --extra '{"per_benchmark":{"gaia_orchestrated":{"matrix":true,"dataset":"sample","max_questions":10,"strict_capabilities":true}}}'
```

## 4) Run lifecycle scenarios
```bash
python -m benchmarks.orchestrator run \
  --benchmarks orchestrator_lifecycle \
  --provider openai \
  --model gpt-4o \
  --extra '{"per_benchmark":{"orchestrator_lifecycle":{"max_scenarios":12,"strict":true}}}'
```

## 5) Unified run
```bash
python -m benchmarks.orchestrator run \
  --benchmarks swe_bench_orchestrated gaia_orchestrated orchestrator_lifecycle \
  --provider openai \
  --model gpt-4o \
  --extra "$(cat benchmarks/orchestrator/profiles/orchestrator_subagents.json)"
```

## 6) Output artifacts
- Orchestrator DB + run metadata under benchmark orchestrator output path
- SWE orchestrated report: `orchestrated-*.json`
- GAIA orchestrated report: `gaia-orchestrated-*.json`
- Lifecycle report: `orchestrator-lifecycle-*.json`
- Trace artifacts under benchmark-specific `traces/` directories
