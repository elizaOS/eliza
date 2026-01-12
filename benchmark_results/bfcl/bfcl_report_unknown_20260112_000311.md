# BFCL Benchmark Report

**Model:** Unknown Model
**Provider:** unknown
**Generated:** 2026-01-12 00:03:11
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 35.90% |
| AST Accuracy | 40.00% |
| Execution Accuracy | 40.00% |
| Relevance Accuracy | 90.00% |

## Test Summary

- **Total Tests:** 10
- **Passed:** 4
- **Failed:** 6
- **Pass Rate:** 40.00%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| parallel | 3 | 66.7% | 66.7% | 66.7% | 321ms |
| rest_api | 2 | 0.0% | 0.0% | 100.0% | 817ms |
| sql | 2 | 0.0% | 0.0% | 100.0% | 830ms |
| java | 3 | 66.7% | 66.7% | 100.0% | 510ms |

## Latency Statistics

- **Average:** 578.6ms
- **P50:** 573.8ms
- **P95:** 1244.4ms
- **P99:** 1244.4ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | -32.60% |
| mistral-large | -33.90% |
| qwen-2.5-72b | -35.30% |
| claude-3-sonnet | -46.40% |
| gemini-1.5-pro | -48.60% |
| claude-3-opus | -49.30% |
| gpt-4-turbo | -52.80% |
| gpt-4o | -53.20% |

## Summary

**Status:** needs_improvement

### Key Findings

- Overall score: 35.90% (AST: 40.00%, Exec: 40.00%)
- Best category: java (66.67%)
- Needs work: sql (0.00%)
- Behind llama-3.1-70b by 32.60%

### Recommendations

- Focus on improving function name and argument matching
- Improve argument type handling and validation

## Error Analysis

| Error Type | Count |
|------------|-------|
| argument_mismatch | 2 |
| extra_call | 2 |
| name_mismatch | 1 |
| missing_call | 1 |
| relevance_error | 1 |
