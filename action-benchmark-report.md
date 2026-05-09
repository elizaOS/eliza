# Action Selection Benchmark

**Selection Accuracy:** 0.0% (0/1)
**Latency:** avg 3269ms · p50 3269ms · p95 3269ms
**Planner Accuracy:** 0.0% (0/1)
**Execution Accuracy:** 0.0% (0/1)
**LLM Token Usage:** input 6312 · output 1546 · total 7858 (2/4 calls reported usage)
**Cache Read:** 0.0% (0/6312 input tokens)
**Cache Write:** 0.0% (0/6312 input tokens)

## By tag

| Tag | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| profile | 0 | 1 | 0.0% |
| standard | 0 | 1 | 0.0% |

## By failure mode

| Mode | Count |
| --- | ---: |
| passed | 0 |
| validate_filtered | 0 |
| llm_chose_reply | 1 |
| llm_chose_other_action | 0 |
| no_response | 0 |
| error | 0 |

## Failures (1)

| Case | Expected | Planned | Completed | Failure Mode | Error |
| --- | --- | --- | --- | --- | --- |
| owner-profile-travel-prefs | PROFILE | (none) | (none) | llm_chose_reply |  |
