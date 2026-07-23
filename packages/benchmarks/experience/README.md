# Experience Benchmark

Benchmark suite for evaluating the built-in advanced capabilities experience service retrieval quality, reranking correctness, and learning cycle effectiveness.

## What it tests

### 1. Retrieval Quality
Generates 1000 synthetic experiences across 10 domains, then evaluates how well the service retrieves relevant experiences for 100 test queries.

**Metrics:**
- **Precision@K** — fraction of top-K results that are relevant
- **Recall@K** — fraction of relevant experiences found in top-K
- **MRR** — Mean Reciprocal Rank of first relevant result
- **Hit Rate@K** — fraction of queries with at least one relevant result in top-K

### 2. Reranking Correctness
Tests three critical properties of the reranking formula:

- **Similarity dominance** — a relevant low-quality experience must outrank an irrelevant high-quality one
- **Quality tiebreaking** — among similarly-relevant experiences, higher quality ranks first
- **Noise rejection** — truly irrelevant experiences are filtered out or rank very low

### 3. Learning Cycle
End-to-end test of the learn-then-apply loop:

1. Load the configured number of background experiences (1,000 by default)
2. Agent encounters a problem and records an experience
3. Agent faces a similar problem later
4. Verify the agent retrieves and applies the past experience

**Metrics:**
- **Experience recall rate** — how often the learned experience appears in results
- **Experience precision rate** — how often it's the top result
- **Cycle success rate** — full end-to-end success (retrieved + keywords match)

## Running

```bash
# Run benchmark tests
cd benchmarks/experience
python -m pytest tests/ -v

# Run the default Eliza bridge benchmark (1000 memories, 100 retrievals, 20 learnings)
# Requires ELIZA_BENCH_URL and ELIZA_BENCH_TOKEN.
python run_benchmark.py

# Run the deterministic in-process service benchmark (no LLM)
python run_benchmark.py --mode direct

# Custom configuration
python run_benchmark.py --experiences 2000 --queries 200 --learning-cycles 50 --output results.json
```

The bridge report records the expected and completed learning/retrieval counts
and is written only after all calls finish. A learning counts as recorded only
when the response contains a structured recording action or the explicit
`RECORD_EXPERIENCE` command.

This suite is not currently a publishable Eliza/Hermes/OpenClaw comparison.
The CLI only owns the Eliza bridge, and the Python `ExperienceService` supplies
the memory implementation. The full campaign therefore marks the cohort
unsupported instead of relabeling provider calls as native harness results.

## Synthetic data generation

The `ExperienceGenerator` creates realistic experiences using domain-specific templates with randomized fill values:

- **10 domains**: coding, shell, network, database, security, ai, devops, testing, documentation, performance
- **8 experience types**: success, failure, discovery, correction, learning, hypothesis, validation, warning
- **Ground truth clusters**: each experience is tagged with a cluster for precision/recall evaluation
- **Reproducible**: seeded random generation for deterministic results

## Runtime coverage

The runtime experience service is built into advanced capabilities in TypeScript (`packages/core/src/features/advanced-capabilities/experience/service.ts`) and uses embeddings with reranking. This benchmark uses a local Python in-memory model (`elizaos_experience_bench/service.py`) so retrieval, reranking, and learning-cycle checks remain runnable without a separate experience plugin checkout.
