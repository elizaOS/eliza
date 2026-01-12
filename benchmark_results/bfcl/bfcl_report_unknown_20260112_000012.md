# BFCL Benchmark Report

**Model:** Unknown Model
**Provider:** unknown
**Generated:** 2026-01-12 00:00:12
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 0.00% |
| AST Accuracy | 0.00% |
| Execution Accuracy | 0.00% |
| Relevance Accuracy | 100.00% |

## Test Summary

- **Total Tests:** 10
- **Passed:** 0
- **Failed:** 10
- **Pass Rate:** 0.00%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| parallel | 2 | 0.0% | 0.0% | 100.0% | 678ms |
| rest_api | 3 | 0.0% | 0.0% | 100.0% | 916ms |
| sql | 3 | 0.0% | 0.0% | 100.0% | 383ms |
| java | 2 | 0.0% | 0.0% | 100.0% | 380ms |

## Latency Statistics

- **Average:** 601.4ms
- **P50:** 487.5ms
- **P95:** 1673.5ms
- **P99:** 1673.5ms

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
| gpt-4o | -89.10% |

## Summary

**Status:** needs_improvement

### Key Findings

- Overall score: 0.00% (AST: 0.00%, Exec: 0.00%)
- Best category: parallel (0.00%)
- Needs work: rest_api (0.00%)
- Behind llama-3.1-70b by 68.50%

### Recommendations

- Focus on improving function name and argument matching
- Improve argument type handling and validation

## Error Analysis

| Error Type | Count |
|------------|-------|
| extra_call | 10 |
