# BFCL Benchmark Report

**Model:** groq/llama-3.1-8b-instant
**Provider:** groq
**Generated:** 2026-02-12 01:01:24
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 6.14% |
| AST Accuracy | 8.82% |
| Execution Accuracy | 8.82% |
| Relevance Accuracy | 43.50% |

## Test Summary

- **Total Tests:** 1508
- **Passed:** 133
- **Failed:** 1375
- **Pass Rate:** 8.82%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| simple | 400 | 2.8% | 2.8% | 57.8% | 994ms |
| multiple | 200 | 3.0% | 3.0% | 35.0% | 1181ms |
| parallel | 200 | 0.0% | 0.0% | 53.0% | 1124ms |
| parallel_multiple | 200 | 0.0% | 0.0% | 41.5% | 1324ms |
| relevance | 258 | 43.0% | 43.0% | 39.9% | 888ms |
| sql | 100 | 0.0% | 0.0% | 21.0% | 952ms |
| java | 100 | 4.0% | 4.0% | 28.0% | 993ms |
| javascript | 50 | 2.0% | 2.0% | 28.0% | 935ms |

## Latency Statistics

- **Average:** 1061.2ms
- **P50:** 687.4ms
- **P95:** 2538.7ms
- **P99:** 5100.1ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | -62.36% |
| mistral-large | -63.66% |
| qwen-2.5-72b | -65.06% |
| claude-3-sonnet | -76.16% |
| gemini-1.5-pro | -78.36% |
| claude-3-opus | -79.06% |
| gpt-4-turbo | -82.56% |
| gpt-5 | -82.96% |

## Summary

**Status:** needs_improvement

### Key Findings

- Overall score: 6.14% (AST: 8.82%, Exec: 8.82%)
- Best category: relevance (43.02%)
- Needs work: sql (0.00%)
- Behind llama-3.1-70b by 62.36%

### Recommendations

- Focus on improving function name and argument matching
- Improve argument type handling and validation
- Better detection of irrelevant queries

## Error Analysis

| Error Type | Count |
|------------|-------|
| missing_call | 876 |
| relevance_error | 839 |
| argument_mismatch | 252 |
| extra_call | 156 |
| name_mismatch | 91 |
| no_ground_truth | 70 |
