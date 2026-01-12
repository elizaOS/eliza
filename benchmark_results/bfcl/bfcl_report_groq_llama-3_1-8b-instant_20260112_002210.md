# BFCL Benchmark Report

**Model:** groq/llama-3.1-8b-instant
**Provider:** groq
**Generated:** 2026-01-12 00:22:10
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 31.03% |
| AST Accuracy | 37.50% |
| Execution Accuracy | 37.50% |
| Relevance Accuracy | 87.50% |

## Test Summary

- **Total Tests:** 8
- **Passed:** 3
- **Failed:** 5
- **Pass Rate:** 37.50%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| parallel | 3 | 33.3% | 33.3% | 66.7% | 433ms |
| sql | 2 | 0.0% | 0.0% | 100.0% | 693ms |
| java | 3 | 66.7% | 66.7% | 100.0% | 320ms |

## Latency Statistics

- **Average:** 439.3ms
- **P50:** 404.1ms
- **P95:** 862.7ms
- **P99:** 862.7ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | -37.47% |
| mistral-large | -38.77% |
| qwen-2.5-72b | -40.17% |
| claude-3-sonnet | -51.27% |
| gemini-1.5-pro | -53.47% |
| claude-3-opus | -54.17% |
| gpt-4-turbo | -57.67% |
| gpt-4o | -58.07% |

## Summary

**Status:** needs_improvement

### Key Findings

- Overall score: 31.03% (AST: 37.50%, Exec: 37.50%)
- Best category: java (66.67%)
- Needs work: sql (0.00%)
- Behind llama-3.1-70b by 37.47%

### Recommendations

- Focus on improving function name and argument matching
- Improve argument type handling and validation

## Error Analysis

| Error Type | Count |
|------------|-------|
| argument_mismatch | 3 |
| no_ground_truth | 2 |
| name_mismatch | 1 |
| missing_call | 1 |
| relevance_error | 1 |
