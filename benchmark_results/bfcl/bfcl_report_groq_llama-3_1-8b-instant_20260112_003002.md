# BFCL Benchmark Report

**Model:** groq/llama-3.1-8b-instant
**Provider:** groq
**Generated:** 2026-01-12 00:30:02
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 70.07% |
| AST Accuracy | 66.67% |
| Execution Accuracy | 66.67% |
| Relevance Accuracy | 97.33% |

## Test Summary

- **Total Tests:** 75
- **Passed:** 50
- **Failed:** 25
- **Pass Rate:** 66.67%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| parallel | 25 | 80.0% | 80.0% | 100.0% | 459ms |
| sql | 25 | 56.0% | 56.0% | 100.0% | 383ms |
| java | 25 | 64.0% | 64.0% | 92.0% | 515ms |

## Latency Statistics

- **Average:** 486.3ms
- **P50:** 449.2ms
- **P95:** 851.4ms
- **P99:** 1717.0ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | +1.57% |
| mistral-large | +0.27% |
| qwen-2.5-72b | -1.13% |
| claude-3-sonnet | -12.23% |
| gemini-1.5-pro | -14.43% |
| claude-3-opus | -15.13% |
| gpt-4-turbo | -18.63% |
| gpt-4o | -19.03% |

## Summary

**Status:** good

### Key Findings

- Overall score: 70.07% (AST: 66.67%, Exec: 66.67%)
- Best category: parallel (80.00%)
- Needs work: sql (56.00%)
- Outperforms mistral-large by 0.27%

### Recommendations

- Focus on improving function name and argument matching
- Improve argument type handling and validation

## Error Analysis

| Error Type | Count |
|------------|-------|
| no_ground_truth | 25 |
| argument_mismatch | 18 |
| name_mismatch | 4 |
| missing_call | 2 |
| relevance_error | 2 |
| extra_call | 1 |
