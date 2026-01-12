# BFCL Benchmark Report

**Model:** groq/llama-3.1-8b-instant
**Provider:** groq
**Generated:** 2026-01-12 00:05:30
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 43.08% |
| AST Accuracy | 40.00% |
| Execution Accuracy | 40.00% |
| Relevance Accuracy | 100.00% |

## Test Summary

- **Total Tests:** 20
- **Passed:** 8
- **Failed:** 12
- **Pass Rate:** 40.00%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| parallel | 5 | 80.0% | 80.0% | 100.0% | 688ms |
| rest_api | 5 | 0.0% | 0.0% | 100.0% | 462ms |
| sql | 5 | 0.0% | 0.0% | 100.0% | 446ms |
| java | 5 | 80.0% | 80.0% | 100.0% | 454ms |

## Latency Statistics

- **Average:** 512.5ms
- **P50:** 470.3ms
- **P95:** 1159.7ms
- **P99:** 1159.7ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | -25.42% |
| mistral-large | -26.72% |
| qwen-2.5-72b | -28.12% |
| claude-3-sonnet | -39.22% |
| gemini-1.5-pro | -41.42% |
| claude-3-opus | -42.12% |
| gpt-4-turbo | -45.62% |
| gpt-4o | -46.02% |

## Summary

**Status:** fair

### Key Findings

- Overall score: 43.08% (AST: 40.00%, Exec: 40.00%)
- Best category: java (80.00%)
- Needs work: sql (0.00%)
- Behind llama-3.1-70b by 25.42%

### Recommendations

- Focus on improving function name and argument matching
- Improve argument type handling and validation

## Error Analysis

| Error Type | Count |
|------------|-------|
| extra_call | 6 |
| argument_mismatch | 4 |
| name_mismatch | 1 |
| missing_call | 1 |
