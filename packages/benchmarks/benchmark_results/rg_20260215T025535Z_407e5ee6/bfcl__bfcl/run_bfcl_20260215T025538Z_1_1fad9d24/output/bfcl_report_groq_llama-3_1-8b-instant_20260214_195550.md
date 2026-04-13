# BFCL Benchmark Report

**Model:** groq/llama-3.1-8b-instant
**Provider:** groq
**Generated:** 2026-02-14 19:55:50
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 0.00% |
| AST Accuracy | 0.00% |
| Execution Accuracy | 0.00% |
| Relevance Accuracy | 11.11% |

## Test Summary

- **Total Tests:** 9
- **Passed:** 0
- **Failed:** 9
- **Pass Rate:** 0.00%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| simple | 2 | 0.0% | 0.0% | 0.0% | 529ms |
| multiple | 1 | 0.0% | 0.0% | 0.0% | 602ms |
| parallel | 1 | 0.0% | 0.0% | 100.0% | 584ms |
| parallel_multiple | 1 | 0.0% | 0.0% | 0.0% | 658ms |
| relevance | 1 | 0.0% | 0.0% | 0.0% | 577ms |
| sql | 1 | 0.0% | 0.0% | 0.0% | 3822ms |
| java | 1 | 0.0% | 0.0% | 0.0% | 566ms |
| javascript | 1 | 0.0% | 0.0% | 0.0% | 2566ms |

## Latency Statistics

- **Average:** 1094.7ms
- **P50:** 584.1ms
- **P95:** 3822.4ms
- **P99:** 3822.4ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | -68.50% |
| mistral-large | -69.80% |
| qwen-2.5-72b | -71.20% |
| claude-3-sonnet | -82.30% |
| gemini-1.5-pro | -84.50% |
| claude-3-opus | -85.20% |
| gpt-4-turbo | -88.70% |
| gpt-5 | -89.10% |

## Summary

**Status:** needs_improvement

### Key Findings

- Overall score: 0.00% (AST: 0.00%, Exec: 0.00%)
- Best category: javascript (0.00%)
- Needs work: multiple (0.00%)
- Behind llama-3.1-70b by 68.50%

### Recommendations

- Focus on improving function name and argument matching
- Improve argument type handling and validation
- Better detection of irrelevant queries

## Error Analysis

| Error Type | Count |
|------------|-------|
| missing_call | 8 |
| relevance_error | 8 |
| extra_call | 1 |
| no_ground_truth | 1 |
