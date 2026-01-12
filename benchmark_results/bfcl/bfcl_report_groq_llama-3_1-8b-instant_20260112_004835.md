# BFCL Benchmark Report

**Model:** groq/llama-3.1-8b-instant
**Provider:** groq
**Generated:** 2026-01-12 00:48:35
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 61.68% |
| AST Accuracy | 63.43% |
| Execution Accuracy | 63.43% |
| Relevance Accuracy | 94.78% |

## Test Summary

- **Total Tests:** 134
- **Passed:** 85
- **Failed:** 49
- **Pass Rate:** 63.43%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| simple | 19 | 68.4% | 68.4% | 100.0% | 350ms |
| multiple | 16 | 50.0% | 50.0% | 100.0% | 338ms |
| parallel | 16 | 68.8% | 68.8% | 100.0% | 498ms |
| parallel_multiple | 17 | 52.9% | 52.9% | 100.0% | 465ms |
| relevance | 17 | 58.8% | 58.8% | 64.7% | 502ms |
| sql | 16 | 56.2% | 56.2% | 100.0% | 375ms |
| java | 16 | 81.2% | 81.2% | 93.8% | 530ms |
| javascript | 17 | 70.6% | 70.6% | 100.0% | 476ms |

## Latency Statistics

- **Average:** 445.1ms
- **P50:** 415.7ms
- **P95:** 690.3ms
- **P99:** 1296.4ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | -6.82% |
| mistral-large | -8.12% |
| qwen-2.5-72b | -9.52% |
| claude-3-sonnet | -20.62% |
| gemini-1.5-pro | -22.82% |
| claude-3-opus | -23.52% |
| gpt-4-turbo | -27.02% |
| gpt-4o | -27.42% |

## Summary

**Status:** good

### Key Findings

- Overall score: 61.68% (AST: 63.43%, Exec: 63.43%)
- Best category: java (81.25%)
- Needs work: multiple (50.00%)
- Behind llama-3.1-70b by 6.82%

### Recommendations

- Focus on improving function name and argument matching
- Improve argument type handling and validation

## Error Analysis

| Error Type | Count |
|------------|-------|
| argument_mismatch | 31 |
| no_ground_truth | 16 |
| name_mismatch | 8 |
| extra_call | 8 |
| relevance_error | 7 |
| missing_call | 2 |
