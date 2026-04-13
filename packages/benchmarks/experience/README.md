# Experience Plugin Benchmark

Benchmark suite for evaluating the ElizaOS experience plugin's retrieval quality, reranking correctness, and learning cycle effectiveness.

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

1. Load 100 background experiences (noise)
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

# Run full benchmark (1000 experiences, 100 queries, 20 learning cycles)
python run_benchmark.py

# Custom configuration
python run_benchmark.py --experiences 2000 --queries 200 --learning-cycles 50 --output results.json
```

## Synthetic data generation

The `ExperienceGenerator` creates realistic experiences using domain-specific templates with randomized fill values:

- **10 domains**: coding, shell, network, database, security, ai, devops, testing, documentation, performance
- **8 experience types**: success, failure, discovery, correction, learning, hypothesis, validation, warning
- **Ground truth clusters**: each experience is tagged with a cluster for precision/recall evaluation
- **Reproducible**: seeded random generation for deterministic results

## Cross-language coverage

The experience plugin is implemented in three languages. This benchmark tests the Python implementation directly, but the same reranking algorithm (similarity 70% + quality 30%) is implemented identically in:

- **TypeScript** (`plugins/plugin-experience/typescript/service.ts`) — uses vector embeddings + cosine similarity
- **Python** (`plugins/plugin-experience/python/elizaos_plugin_experience/service.py`) — uses token overlap + Jaccard similarity
- **Rust** (`plugins/plugin-experience/rust/src/service.rs`) — uses token overlap + Jaccard similarity
