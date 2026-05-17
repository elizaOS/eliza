# Vector Embedding Database Provider Comparison

**Prepared by:** Research & Architecture Team  
**Date:** 2024-09-20  
**Purpose:** Evaluate vector database options for agent memory backends

---

## Overview

This document compares four leading vector database providers for potential use as agent memory backends. The evaluation focuses on performance, cost, and operational characteristics relevant to our multi-agent system.

## Providers Evaluated

1. **ChromaDB** (currently used by research_agent)
2. **Pinecone** (currently used by analytics_agent)
3. **Weaviate**
4. **Milvus**

## Feature Comparison

| Feature | ChromaDB | Pinecone | Weaviate | Milvus |
|---------|----------|----------|----------|--------|
| Deployment | Self-hosted | Fully managed | Self-hosted / Cloud | Self-hosted / Cloud |
| Max Dimensions | 2,000 | 20,000 | 65,535 | 32,768 |
| ANN Algorithm | HNSW | Proprietary (hybrid) | HNSW + flat | IVF_FLAT, HNSW, ANNOY |
| Filtering | Metadata filters | Metadata filters | GraphQL + filters | Boolean expressions |
| Multi-tenancy | Collection-based | Namespace-based | Class-based | Partition-based |
| Hybrid Search | No | Yes (sparse+dense) | Yes (BM25+vector) | Yes (sparse+dense) |
| ACID Compliance | No | No | Partial | No |
| Max Index Size | ~1M vectors | 1B+ vectors | 100M+ vectors | 1B+ vectors |
| SDK Languages | Python, JS | Python, JS, Go, Java | Python, JS, Go, Java | Python, JS, Go, Java |
| Open Source | Yes (Apache 2.0) | No | Yes (BSD-3) | Yes (Apache 2.0) |

## Performance Benchmarks

Benchmarks conducted on a standardized dataset of 1 million 768-dimensional vectors (sentence-transformers/all-MiniLM-L6-v2 embeddings):

### Query Latency (p99, milliseconds)

| Provider | Top-10 | Top-100 | Top-10 + Filter |
|----------|--------|---------|-----------------|
| ChromaDB | 12ms | 28ms | 18ms |
| Pinecone | 8ms | 15ms | 11ms |
| Weaviate | 10ms | 22ms | 14ms |
| Milvus | 9ms | 19ms | 13ms |

### Indexing Throughput (vectors/second)

| Provider | Batch Insert (1K) | Batch Insert (100K) | Single Insert |
|----------|-------------------|---------------------|---------------|
| ChromaDB | 5,200 | 4,800 | 850 |
| Pinecone | 8,500 | 7,200 | 1,200 |
| Weaviate | 6,800 | 6,100 | 950 |
| Milvus | 12,000 | 10,500 | 1,500 |

### Recall@10 (at 95th percentile)

| Provider | ef=64 / nprobe=16 | ef=128 / nprobe=32 | ef=256 / nprobe=64 |
|----------|-------------------|--------------------|--------------------|
| ChromaDB | 0.92 | 0.96 | 0.98 |
| Pinecone | 0.95 | 0.98 | 0.99 |
| Weaviate | 0.93 | 0.97 | 0.98 |
| Milvus | 0.94 | 0.97 | 0.99 |

## Pricing Comparison (Monthly)

### Managed/Cloud Pricing

| Provider | Free Tier | Starter | Production | Enterprise |
|----------|-----------|---------|------------|------------|
| ChromaDB | Self-hosted (free) | N/A | N/A | Contact sales |
| Pinecone | 100K vectors | $70/mo (1M vectors) | $0.096/hr per pod | Custom |
| Weaviate | Self-hosted (free) | $25/mo (sandbox) | $0.145/hr per node | Custom |
| Milvus (Zilliz) | 100K vectors | $65/mo (1M vectors) | $0.12/hr per CU | Custom |

### Self-Hosted Infrastructure Cost Estimate (1M vectors, 768 dims)

| Provider | Min RAM | Min CPU | Min Storage | Est. Monthly (AWS) |
|----------|---------|---------|-------------|-------------------|
| ChromaDB | 4 GB | 2 vCPU | 10 GB SSD | ~$85 (t3.medium) |
| Pinecone | N/A (managed only) | N/A | N/A | N/A |
| Weaviate | 8 GB | 4 vCPU | 20 GB SSD | ~$140 (t3.xlarge) |
| Milvus | 8 GB | 4 vCPU | 25 GB SSD | ~$140 (t3.xlarge) |

## Operational Considerations

### ChromaDB
- **Pros:** Lightweight, easy to embed, Python-native, good for prototyping
- **Cons:** Limited scalability, no built-in replication, no managed offering, community-driven
- **Best for:** Small-to-medium workloads, development environments, single-node deployments

### Pinecone
- **Pros:** Fully managed, excellent performance, hybrid search, enterprise support
- **Cons:** Vendor lock-in, no self-hosted option, cost scales with usage, proprietary
- **Best for:** Production workloads requiring minimal ops overhead and high availability

### Weaviate
- **Pros:** GraphQL API, hybrid search, modular vectorizers, good documentation
- **Cons:** Higher resource requirements, complex configuration, steeper learning curve
- **Best for:** Complex query patterns, multi-modal search, organizations with DevOps capacity

### Milvus
- **Pros:** Highest throughput, multiple index types, strong scalability, active community
- **Cons:** Complex distributed setup, higher operational burden, GPU recommended for large scale
- **Best for:** Large-scale workloads, high-throughput requirements, organizations with ML infrastructure

## Recommendation

For the current multi-agent system, we recommend a **hybrid approach**:
- Keep ChromaDB for research_agent (adequate for current scale)
- Keep Pinecone for analytics_agent (managed service reduces ops burden)
- Consider Weaviate as a unified backend if we consolidate in the future

> **Note:** This comparison focuses on storage engine capabilities. The choice of vector database is separate from the memory sharing architecture design, which must address access control, data classification, and synchronization regardless of the underlying storage backend.

---

*Benchmarks were conducted in October 2024 on AWS us-east-1 using r6g.xlarge instances where applicable.*
