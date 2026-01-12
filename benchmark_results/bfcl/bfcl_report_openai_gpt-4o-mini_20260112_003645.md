# BFCL Benchmark Report

**Model:** openai/gpt-4o-mini
**Provider:** openai
**Generated:** 2026-01-12 00:36:45
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 53.14% |
| AST Accuracy | 52.17% |
| Execution Accuracy | 52.17% |
| Relevance Accuracy | 100.00% |

## Test Summary

- **Total Tests:** 23
- **Passed:** 12
- **Failed:** 11
- **Pass Rate:** 52.17%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| parallel | 8 | 62.5% | 62.5% | 100.0% | 11948ms |
| sql | 7 | 28.6% | 28.6% | 100.0% | 12191ms |
| java | 8 | 62.5% | 62.5% | 100.0% | 6517ms |

## Latency Statistics

- **Average:** 12432.8ms
- **P50:** 10713.1ms
- **P95:** 32581.7ms
- **P99:** 37520.4ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | -15.36% |
| mistral-large | -16.66% |
| qwen-2.5-72b | -18.06% |
| claude-3-sonnet | -29.16% |
| gemini-1.5-pro | -31.36% |
| claude-3-opus | -32.06% |
| gpt-4-turbo | -35.56% |
| gpt-4o | -35.96% |

## Summary

**Status:** fair

### Key Findings

- Overall score: 53.14% (AST: 52.17%, Exec: 52.17%)
- Best category: java (62.50%)
- Needs work: sql (28.57%)
- Behind llama-3.1-70b by 15.36%

### Recommendations

- Focus on improving function name and argument matching
- Improve argument type handling and validation

## Error Analysis

| Error Type | Count |
|------------|-------|
| no_ground_truth | 7 |
| argument_mismatch | 6 |
| name_mismatch | 4 |
| missing_call | 1 |
