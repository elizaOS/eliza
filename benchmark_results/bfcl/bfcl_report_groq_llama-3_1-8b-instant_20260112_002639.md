# BFCL Benchmark Report

**Model:** groq/llama-3.1-8b-instant
**Provider:** groq
**Generated:** 2026-01-12 00:26:39
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 60.83% |
| AST Accuracy | 58.67% |
| Execution Accuracy | 58.67% |
| Relevance Accuracy | 96.00% |

## Test Summary

- **Total Tests:** 75
- **Passed:** 44
- **Failed:** 31
- **Pass Rate:** 58.67%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| parallel | 25 | 68.0% | 68.0% | 96.0% | 484ms |
| sql | 25 | 48.0% | 48.0% | 100.0% | 432ms |
| java | 25 | 60.0% | 60.0% | 92.0% | 396ms |

## Latency Statistics

- **Average:** 468.9ms
- **P50:** 426.0ms
- **P95:** 888.2ms
- **P99:** 1995.3ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | -7.67% |
| mistral-large | -8.97% |
| qwen-2.5-72b | -10.37% |
| claude-3-sonnet | -21.47% |
| gemini-1.5-pro | -23.67% |
| claude-3-opus | -24.37% |
| gpt-4-turbo | -27.87% |
| gpt-4o | -28.27% |

## Summary

**Status:** good

### Key Findings

- Overall score: 60.83% (AST: 58.67%, Exec: 58.67%)
- Best category: parallel (68.00%)
- Needs work: sql (48.00%)
- Behind llama-3.1-70b by 7.67%

### Recommendations

- Focus on improving function name and argument matching
- Improve argument type handling and validation

## Error Analysis

| Error Type | Count |
|------------|-------|
| no_ground_truth | 25 |
| argument_mismatch | 24 |
| name_mismatch | 4 |
| missing_call | 3 |
| relevance_error | 3 |
