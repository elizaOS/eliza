# Embedding Model Comparison for Semantic Search

**Date:** 2024-04-10  
**Author:** David Liu  
**Purpose:** Evaluate embedding models for potential integration into the semantic similarity component of the retrieval scoring pipeline.

---

## Overview

As part of ongoing efforts to improve retrieval quality, we evaluated four embedding models for computing semantic similarity between queries and memory entries. This comparison focuses on latency, embedding dimensions, and general accuracy on standard benchmarks.

> **Note:** This evaluation is independent of the current retrieval pipeline issues. The semantic similarity weight in our scoring is currently 0.20, making it a secondary signal. The primary retrieval challenges are related to quota allocation and truncation behavior, not embedding quality.

---

## Models Evaluated

| Model | Provider | Dimensions | Max Tokens | Release Date |
|-------|----------|-----------|------------|--------------|
| text-embedding-ada-002 | OpenAI | 1536 | 8191 | Dec 2022 |
| bge-large-en-v1.5 | BAAI | 1024 | 512 | Sep 2023 |
| e5-large-v2 | Microsoft | 1024 | 512 | May 2023 |
| instructor-xl | HKU NLP | 768 | 512 | Dec 2022 |

## Latency Benchmarks

Measured on a single A100 GPU (batch size = 32, averaged over 1000 batches):

| Model | Avg Latency (ms/batch) | P95 Latency (ms) | P99 Latency (ms) |
|-------|----------------------|-------------------|-------------------|
| ada-002 (API) | 45.2 | 62.1 | 89.3 |
| bge-large | 12.8 | 18.4 | 24.7 |
| e5-large | 13.1 | 19.2 | 26.1 |
| instructor-xl | 18.5 | 25.3 | 33.8 |

**Notes:**
- ada-002 latency includes network round-trip to OpenAI API
- Local models (bge, e5, instructor) run on-premise
- instructor-xl is slower due to instruction-following overhead

## Accuracy on MTEB Retrieval Tasks

Scores on the MTEB (Massive Text Embedding Benchmark) retrieval subset:

| Model | NDCG@10 | MRR@10 | Recall@100 |
|-------|---------|--------|------------|
| ada-002 | 0.521 | 0.498 | 0.847 |
| bge-large | 0.548 | 0.523 | 0.862 |
| e5-large | 0.539 | 0.515 | 0.855 |
| instructor-xl | 0.531 | 0.507 | 0.851 |

## Memory Footprint

| Model | Model Size (GB) | Index Size per 1K docs (MB) |
|-------|-----------------|---------------------------|
| ada-002 | N/A (API) | 6.1 |
| bge-large | 1.3 | 4.1 |
| e5-large | 1.3 | 4.1 |
| instructor-xl | 4.9 | 3.1 |

## Cost Analysis

| Model | Cost per 1M tokens | Monthly est. (500 queries/day) |
|-------|--------------------|-----------------------------|
| ada-002 | $0.0001 | ~$4.50 |
| bge-large | Self-hosted | ~$0 (amortized GPU cost) |
| e5-large | Self-hosted | ~$0 (amortized GPU cost) |
| instructor-xl | Self-hosted | ~$0 (amortized GPU cost) |

## Recommendation

Based on accuracy and latency, **bge-large-en-v1.5** offers the best balance for our use case. However, given that semantic similarity currently accounts for only 20% of the composite score, the choice of embedding model has limited impact on overall retrieval quality.

The more impactful improvements would come from addressing the truncation and quota allocation issues documented in the system architecture and prior proposals.

## Appendix: Test Queries Used

1. "How do I configure authentication tokens?"
2. "What is the database replication strategy?"
3. "Explain the deployment rollback procedure"
4. "Show monitoring dashboard setup instructions"
5. "What are the rate limiting thresholds?"

All models produced similar top-10 results for these queries, with Jaccard similarity > 0.85 between any pair of models.
