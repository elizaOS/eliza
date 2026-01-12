# BFCL Benchmark Report

**Model:** groq/llama-3.1-8b-instant
**Provider:** groq
**Generated:** 2026-01-12 00:09:59
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 39.97% |
| AST Accuracy | 40.00% |
| Execution Accuracy | 40.00% |
| Relevance Accuracy | 98.00% |

## Test Summary

- **Total Tests:** 50
- **Passed:** 20
- **Failed:** 30
- **Pass Rate:** 40.00%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| parallel | 13 | 61.5% | 61.5% | 100.0% | 517ms |
| rest_api | 12 | 0.0% | 0.0% | 100.0% | 573ms |
| sql | 12 | 33.3% | 33.3% | 100.0% | 351ms |
| java | 13 | 61.5% | 61.5% | 92.3% | 381ms |

## Latency Statistics

- **Average:** 455.3ms
- **P50:** 416.7ms
- **P95:** 808.5ms
- **P99:** 1107.3ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | -28.53% |
| mistral-large | -29.83% |
| qwen-2.5-72b | -31.23% |
| claude-3-sonnet | -42.33% |
| gemini-1.5-pro | -44.53% |
| claude-3-opus | -45.23% |
| gpt-4-turbo | -48.73% |
| gpt-4o | -49.13% |

## Summary

**Status:** needs_improvement

### Key Findings

- Overall score: 39.97% (AST: 40.00%, Exec: 40.00%)
- Best category: parallel (61.54%)
- Needs work: rest_api (0.00%)
- Behind llama-3.1-70b by 28.53%

### Recommendations

- Focus on improving function name and argument matching
- Improve argument type handling and validation

## Error Analysis

| Error Type | Count |
|------------|-------|
| argument_mismatch | 17 |
| extra_call | 12 |
| missing_call | 1 |
| relevance_error | 1 |
