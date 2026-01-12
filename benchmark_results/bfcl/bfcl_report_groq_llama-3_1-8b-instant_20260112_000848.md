# BFCL Benchmark Report

**Model:** groq/llama-3.1-8b-instant
**Provider:** groq
**Generated:** 2026-01-12 00:08:48
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 25.64% |
| AST Accuracy | 24.00% |
| Execution Accuracy | 24.00% |
| Relevance Accuracy | 0.00% |

## Test Summary

- **Total Tests:** 50
- **Passed:** 12
- **Failed:** 38
- **Pass Rate:** 24.00%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| parallel | 13 | 0.0% | 0.0% | 0.0% | 2192ms |
| rest_api | 12 | 100.0% | 100.0% | 0.0% | 2226ms |
| sql | 12 | 0.0% | 0.0% | 0.0% | 2192ms |
| java | 13 | 0.0% | 0.0% | 0.0% | 2202ms |

## Latency Statistics

- **Average:** 2202.7ms
- **P50:** 2195.2ms
- **P95:** 2277.2ms
- **P99:** 2390.2ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | -42.86% |
| mistral-large | -44.16% |
| qwen-2.5-72b | -45.56% |
| claude-3-sonnet | -56.66% |
| gemini-1.5-pro | -58.86% |
| claude-3-opus | -59.56% |
| gpt-4-turbo | -63.06% |
| gpt-4o | -63.46% |

## Summary

**Status:** needs_improvement

### Key Findings

- Overall score: 25.64% (AST: 24.00%, Exec: 24.00%)
- Best category: rest_api (100.00%)
- Needs work: sql (0.00%)
- Behind llama-3.1-70b by 42.86%

### Recommendations

- Focus on improving function name and argument matching
- Improve argument type handling and validation
- Better detection of irrelevant queries

## Error Analysis

| Error Type | Count |
|------------|-------|
| missing_call | 38 |
| relevance_error | 38 |
