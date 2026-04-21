# BFCL Benchmark Report

**Model:** Unknown Model
**Provider:** groq
**Generated:** 2026-02-11 23:24:38
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 11.11% |
| AST Accuracy | 17.11% |
| Execution Accuracy | 17.11% |
| Relevance Accuracy | 15.92% |

## Test Summary

- **Total Tests:** 1508
- **Passed:** 258
- **Failed:** 1250
- **Pass Rate:** 17.11%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| simple | 400 | 0.0% | 0.0% | 0.0% | 0ms |
| multiple | 200 | 0.0% | 0.0% | 0.0% | 0ms |
| parallel | 200 | 0.0% | 0.0% | 0.0% | 0ms |
| parallel_multiple | 200 | 0.0% | 0.0% | 0.0% | 0ms |
| relevance | 258 | 100.0% | 100.0% | 93.0% | 0ms |
| sql | 100 | 0.0% | 0.0% | 0.0% | 0ms |
| java | 100 | 0.0% | 0.0% | 0.0% | 0ms |
| javascript | 50 | 0.0% | 0.0% | 0.0% | 0ms |

## Latency Statistics

- **Average:** 0.0ms
- **P50:** 0.0ms
- **P95:** 0.0ms
- **P99:** 0.0ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | -57.39% |
| mistral-large | -58.69% |
| qwen-2.5-72b | -60.09% |
| claude-3-sonnet | -71.19% |
| gemini-1.5-pro | -73.39% |
| claude-3-opus | -74.09% |
| gpt-4-turbo | -77.59% |
| gpt-5 | -77.99% |

## Summary

**Status:** needs_improvement

### Key Findings

- Overall score: 11.11% (AST: 17.11%, Exec: 17.11%)
- Best category: relevance (100.00%)
- Needs work: javascript (0.00%)
- Behind llama-3.1-70b by 57.39%

### Recommendations

- Focus on improving function name and argument matching
- Improve argument type handling and validation
- Better detection of irrelevant queries

## Error Analysis

| Error Type | Count |
|------------|-------|
| missing_call | 1250 |
| relevance_error | 1250 |
| no_ground_truth | 70 |
