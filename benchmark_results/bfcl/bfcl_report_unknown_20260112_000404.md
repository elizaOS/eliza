# BFCL Benchmark Report

**Model:** Unknown Model
**Provider:** unknown
**Generated:** 2026-01-12 00:04:04
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 40.00% |
| AST Accuracy | 35.00% |
| Execution Accuracy | 35.00% |
| Relevance Accuracy | 95.00% |

## Test Summary

- **Total Tests:** 20
- **Passed:** 7
- **Failed:** 13
- **Pass Rate:** 35.00%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| parallel | 5 | 80.0% | 80.0% | 100.0% | 932ms |
| rest_api | 5 | 0.0% | 0.0% | 100.0% | 504ms |
| sql | 5 | 0.0% | 0.0% | 100.0% | 527ms |
| java | 5 | 60.0% | 60.0% | 80.0% | 556ms |

## Latency Statistics

- **Average:** 629.9ms
- **P50:** 527.4ms
- **P95:** 2340.3ms
- **P99:** 2340.3ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | -28.50% |
| mistral-large | -29.80% |
| qwen-2.5-72b | -31.20% |
| claude-3-sonnet | -42.30% |
| gemini-1.5-pro | -44.50% |
| claude-3-opus | -45.20% |
| gpt-4-turbo | -48.70% |
| gpt-4o | -49.10% |

## Summary

**Status:** fair

### Key Findings

- Overall score: 40.00% (AST: 35.00%, Exec: 35.00%)
- Best category: parallel (80.00%)
- Needs work: rest_api (0.00%)
- Behind llama-3.1-70b by 28.50%

### Recommendations

- Focus on improving function name and argument matching
- Improve argument type handling and validation

## Error Analysis

| Error Type | Count |
|------------|-------|
| extra_call | 5 |
| argument_mismatch | 4 |
| name_mismatch | 3 |
| missing_call | 1 |
| relevance_error | 1 |
