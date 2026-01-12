# BFCL Benchmark Report

**Model:** groq/llama-3.1-8b-instant
**Provider:** groq
**Generated:** 2026-01-12 00:23:04
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 57.74% |
| AST Accuracy | 55.26% |
| Execution Accuracy | 55.26% |
| Relevance Accuracy | 92.11% |

## Test Summary

- **Total Tests:** 38
- **Passed:** 21
- **Failed:** 17
- **Pass Rate:** 55.26%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| parallel | 13 | 69.2% | 69.2% | 76.9% | 382ms |
| sql | 12 | 33.3% | 33.3% | 100.0% | 447ms |
| java | 13 | 61.5% | 61.5% | 100.0% | 537ms |

## Latency Statistics

- **Average:** 467.3ms
- **P50:** 451.6ms
- **P95:** 759.0ms
- **P99:** 1888.2ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | -10.76% |
| mistral-large | -12.06% |
| qwen-2.5-72b | -13.46% |
| claude-3-sonnet | -24.56% |
| gemini-1.5-pro | -26.76% |
| claude-3-opus | -27.46% |
| gpt-4-turbo | -30.96% |
| gpt-4o | -31.36% |

## Summary

**Status:** fair

### Key Findings

- Overall score: 57.74% (AST: 55.26%, Exec: 55.26%)
- Best category: parallel (69.23%)
- Needs work: sql (33.33%)
- Behind llama-3.1-70b by 10.76%

### Recommendations

- Focus on improving function name and argument matching
- Improve argument type handling and validation

## Error Analysis

| Error Type | Count |
|------------|-------|
| no_ground_truth | 12 |
| argument_mismatch | 11 |
| missing_call | 3 |
| relevance_error | 3 |
| name_mismatch | 2 |
| extra_call | 1 |
