# BFCL Benchmark Report

**Model:** Unknown Model
**Provider:** unknown
**Generated:** 2026-01-11 23:54:45
**BFCL Version:** v3

## Overview

| Metric | Score |
|--------|-------|
| Overall Score | 100.00% |
| AST Accuracy | 100.00% |
| Execution Accuracy | 100.00% |
| Relevance Accuracy | 0.00% |

## Test Summary

- **Total Tests:** 10
- **Passed:** 10
- **Failed:** 0
- **Pass Rate:** 100.00%

## Category Breakdown

| Category | Tests | AST | Exec | Relevance | Latency |
|----------|-------|-----|------|-----------|---------|
| parallel | 3 | 100.0% | 100.0% | 0.0% | 184ms |
| rest_api | 2 | 100.0% | 100.0% | 0.0% | 170ms |
| sql | 2 | 100.0% | 100.0% | 0.0% | 172ms |
| java | 3 | 100.0% | 100.0% | 0.0% | 86ms |

## Latency Statistics

- **Average:** 149.4ms
- **P50:** 171.8ms
- **P95:** 199.6ms
- **P99:** 199.6ms

## Baseline Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | +31.50% |
| mistral-large | +30.20% |
| qwen-2.5-72b | +28.80% |
| claude-3-sonnet | +17.70% |
| gemini-1.5-pro | +15.50% |
| claude-3-opus | +14.80% |
| gpt-4-turbo | +11.30% |
| gpt-4o | +10.90% |

## Summary

**Status:** excellent

### Key Findings

- Overall score: 100.00% (AST: 100.00%, Exec: 100.00%)
- Best category: java (100.00%)
- Needs work: sql (100.00%)
- Outperforms gpt-4o by 10.90%

### Recommendations

- Better detection of irrelevant queries

## Error Analysis

| Error Type | Count |
|------------|-------|
