# BFCL Benchmark Report

**Model:** openai/gpt-5-mini
**Provider:** openai
**Generated:** 2026-02-06 10:25:56
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 83.33% |
| AST Accuracy | 88.89% |
| Execution Accuracy | 88.89% |
| Relevance Accuracy | 100.00% |

## Test Summary

- **Total Tests:** 9
- **Passed:** 8
- **Failed:** 1
- **Pass Rate:** 88.89%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| simple | 1 | 100.0% | 100.0% | 100.0% | 1703ms |
| multiple | 2 | 100.0% | 100.0% | 100.0% | 4948ms |
| parallel | 1 | 100.0% | 100.0% | 100.0% | 3433ms |
| parallel_multiple | 1 | 0.0% | 0.0% | 100.0% | 12306ms |
| relevance | 1 | 100.0% | 100.0% | 100.0% | 11686ms |
| sql | 1 | 100.0% | 100.0% | 100.0% | 3868ms |
| java | 1 | 100.0% | 100.0% | 100.0% | 2991ms |
| javascript | 1 | 100.0% | 100.0% | 100.0% | 3109ms |

## Latency Statistics

- **Average:** 5203.6ms
- **P50:** 3432.8ms
- **P95:** 12305.7ms
- **P99:** 12305.7ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | +14.83% |
| mistral-large | +13.53% |
| qwen-2.5-72b | +12.13% |
| claude-3-sonnet | +1.03% |
| gemini-1.5-pro | -1.17% |
| claude-3-opus | -1.87% |
| gpt-4-turbo | -5.37% |
| gpt-5 | -5.77% |

## Summary

**Status:** excellent

### Key Findings

- Overall score: 83.33% (AST: 88.89%, Exec: 88.89%)
- Best category: parallel (100.00%)
- Needs work: parallel_multiple (0.00%)
- Outperforms claude-3-sonnet by 1.03%

## Error Analysis

| Error Type | Count |
|------------|-------|
| argument_mismatch | 1 |
| no_ground_truth | 1 |
