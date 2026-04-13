# ADHDBench Report

**Model**: qwen/qwen3-32b
**Provider**: groq
**Timestamp**: 2026-02-11T23:24:37Z
**Total Scenarios Run**: 420
**Duration**: 20915ms

## Baselines

| Baseline | Score |
|----------|-------|
| random | 29.5% |
| always_reply | 48.9% |

## Attention Scaling Curves

### Config: basic

```
  Attention Scaling Curve (basic)

   100% |                                              
    90% |                                              
    80% |                                              
    70% |                                              
    60% |                                              
    50% |                                              
    40% |                                              
    30% |  ##        ##        ##        ##        ##  
    20% |  ##        ##        ##        ##        ##  
    10% |  ##        ##        ##        ##        ##  
     0% |  ##        ##        ##        ##        ##  
        +---------------------------------
          a10_p8_m0   a25_p12_m10  a50_p18_m30  a100_p24_m60  a200_p30_m100
```

| Scale Point | Actions | Providers | Prefill | Score | Latency (ms) | Scenarios |
|-------------|---------|-----------|---------|-------|-------------|-----------|
| a10_p8_m0 | 10 | 8 | 0 | 32.2% | 7 | 39 |
| a25_p12_m10 | 25 | 12 | 10 | 32.2% | 8 | 39 |
| a50_p18_m30 | 50 | 18 | 30 | 32.2% | 14 | 39 |
| a100_p24_m60 | 100 | 24 | 60 | 32.2% | 28 | 39 |
| a200_p30_m100 | 200 | 30 | 100 | 32.2% | 64 | 39 |

### Config: full

```
  Attention Scaling Curve (full)

   100% |                                              
    90% |                                              
    80% |                                              
    70% |                                              
    60% |                                              
    50% |                                              
    40% |                                              
    30% |                                              
    20% |  ##        ##        ##        ##        ##  
    10% |  ##        ##        ##        ##        ##  
     0% |  ##        ##        ##        ##        ##  
        +---------------------------------
          a10_p8_m0   a25_p12_m10  a50_p18_m30  a100_p24_m60  a200_p30_m100
```

| Scale Point | Actions | Providers | Prefill | Score | Latency (ms) | Scenarios |
|-------------|---------|-----------|---------|-------|-------------|-----------|
| a10_p8_m0 | 10 | 8 | 0 | 29.5% | 54 | 45 |
| a25_p12_m10 | 25 | 12 | 10 | 29.5% | 55 | 45 |
| a50_p18_m30 | 50 | 18 | 30 | 29.5% | 63 | 45 |
| a100_p24_m60 | 100 | 24 | 60 | 29.5% | 78 | 45 |
| a200_p30_m100 | 200 | 30 | 100 | 29.5% | 109 | 45 |

## Per-Level Breakdown

| Config/Level | Scale Point | Avg Score | Count |
|-------------|-------------|-----------|-------|
| basic/ACTION_DISPATCH | a100_p24_m60 | 57.4% | 19 |
| basic/ACTION_DISPATCH | a10_p8_m0 | 57.4% | 19 |
| basic/ACTION_DISPATCH | a200_p30_m100 | 57.4% | 19 |
| basic/ACTION_DISPATCH | a25_p12_m10 | 57.4% | 19 |
| basic/ACTION_DISPATCH | a50_p18_m30 | 57.4% | 19 |
| basic/COMPLEX_EXECUTION | a100_p24_m60 | 6.9% | 8 |
| basic/COMPLEX_EXECUTION | a10_p8_m0 | 6.9% | 8 |
| basic/COMPLEX_EXECUTION | a200_p30_m100 | 6.9% | 8 |
| basic/COMPLEX_EXECUTION | a25_p12_m10 | 6.9% | 8 |
| basic/COMPLEX_EXECUTION | a50_p18_m30 | 6.9% | 8 |
| basic/CONTEXT_TRACKING | a100_p24_m60 | 9.0% | 12 |
| basic/CONTEXT_TRACKING | a10_p8_m0 | 9.0% | 12 |
| basic/CONTEXT_TRACKING | a200_p30_m100 | 9.0% | 12 |
| basic/CONTEXT_TRACKING | a25_p12_m10 | 9.0% | 12 |
| basic/CONTEXT_TRACKING | a50_p18_m30 | 9.0% | 12 |
| full/ACTION_DISPATCH | a100_p24_m60 | 57.0% | 20 |
| full/ACTION_DISPATCH | a10_p8_m0 | 57.0% | 20 |
| full/ACTION_DISPATCH | a200_p30_m100 | 57.0% | 20 |
| full/ACTION_DISPATCH | a25_p12_m10 | 57.0% | 20 |
| full/ACTION_DISPATCH | a50_p18_m30 | 57.0% | 20 |
| full/COMPLEX_EXECUTION | a100_p24_m60 | 8.1% | 10 |
| full/COMPLEX_EXECUTION | a10_p8_m0 | 8.1% | 10 |
| full/COMPLEX_EXECUTION | a200_p30_m100 | 8.1% | 10 |
| full/COMPLEX_EXECUTION | a25_p12_m10 | 8.1% | 10 |
| full/COMPLEX_EXECUTION | a50_p18_m30 | 8.1% | 10 |
| full/CONTEXT_TRACKING | a100_p24_m60 | 7.2% | 15 |
| full/CONTEXT_TRACKING | a10_p8_m0 | 7.2% | 15 |
| full/CONTEXT_TRACKING | a200_p30_m100 | 7.2% | 15 |
| full/CONTEXT_TRACKING | a25_p12_m10 | 7.2% | 15 |
| full/CONTEXT_TRACKING | a50_p18_m30 | 7.2% | 15 |

## Lowest Scoring Scenarios

| Scenario | Config | Scale | Score | Error |
|----------|--------|-------|-------|-------|
| L1-001: Rapid topic switch | basic | a10_p8_m0 | 0.0% | - |
| L1-002: Buried instruction | basic | a10_p8_m0 | 0.0% | - |
| L1-003: Entity tracking across turns | basic | a10_p8_m0 | 0.0% | - |
| L1-006: Distraction resistance | basic | a10_p8_m0 | 0.0% | - |
| L1-007: Numerical recall | basic | a10_p8_m0 | 0.0% | - |
| L1-008: Implicit reference resolution | basic | a10_p8_m0 | 0.0% | - |
| L1-010: Action momentum | basic | a10_p8_m0 | 0.0% | - |
| L1-013: Time sensitivity | basic | a10_p8_m0 | 0.0% | - |
| L1-014: Handling ambiguity then learning | basic | a10_p8_m0 | 0.0% | - |
| L2-001: Full contact workflow | basic | a10_p8_m0 | 0.0% | - |
| L2-002: Room setup | basic | a10_p8_m0 | 0.0% | - |
| L2-003: Research and report | basic | a10_p8_m0 | 0.0% | - |
| L2-006: Conditional execution | basic | a10_p8_m0 | 0.0% | - |
| L2-007: Correction mid-task | basic | a10_p8_m0 | 0.0% | - |
| L2-008: Priority conflict | basic | a10_p8_m0 | 0.0% | - |
| L1-001: Rapid topic switch | basic | a25_p12_m10 | 0.0% | - |
| L1-002: Buried instruction | basic | a25_p12_m10 | 0.0% | - |
| L1-003: Entity tracking across turns | basic | a25_p12_m10 | 0.0% | - |
| L1-006: Distraction resistance | basic | a25_p12_m10 | 0.0% | - |
| L1-007: Numerical recall | basic | a25_p12_m10 | 0.0% | - |

## Failed Outcome Details

### L1-001: Rapid topic switch (basic, a10_p8_m0)

**Turn 1** (actions: none)
  - FAIL [action_match]: Expected one of ['REPLY'], got []. No match

**Turn 2** (actions: none)
  - FAIL [action_match]: Expected one of ['REPLY'], got []. No match
  - FAIL [text_contains]: 'apartment' not found in response: '...'

**Turn 3** (actions: none)
  - FAIL [action_match]: Expected one of ['SCHEDULE_FOLLOW_UP'], got []. No match

**Turn 4** (actions: none)
  - FAIL [action_match]: Expected one of ['REPLY'], got []. No match
  - FAIL [text_contains]: 'apartment' not found in response: '...'

**Turn 5** (actions: none)
  - FAIL [action_match]: Expected one of ['REPLY'], got []. No match
  - FAIL [text_contains]: 'vet' not found in response: '...'
  - FAIL [text_contains]: 'Friday' not found in response: '...'

### L1-002: Buried instruction (basic, a10_p8_m0)

**Turn 10** (actions: none)
  - FAIL [action_match]: Expected one of ['ADD_CONTACT'], got []. No match

**Turn 11** (actions: none)
  - FAIL [action_match]: Expected one of ['REPLY'], got []. No match
  - FAIL [text_contains]: 'Bob' not found in response: '...'
  - FAIL [text_contains]: 'contact' not found in response: '...'

### L1-003: Entity tracking across turns (basic, a10_p8_m0)

**Turn 6** (actions: none)
  - FAIL [action_match]: Expected one of ['REPLY'], got []. No match
  - FAIL [text_contains]: 'Bob' not found in response: '...'

**Turn 7** (actions: none)
  - FAIL [action_match]: Expected one of ['REPLY'], got []. No match
  - FAIL [text_contains]: 'project manager' not found in response: '...'

**Turn 8** (actions: none)
  - FAIL [action_match]: Expected one of ['REPLY'], got []. No match
  - FAIL [text_contains]: 'Eve' not found in response: '...'

### L1-006: Distraction resistance (basic, a10_p8_m0)

**Turn 13** (actions: none)
  - FAIL [action_match]: Expected one of ['REPLY'], got []. No match
  - FAIL [text_contains]: 'invitation' not found in response: '...'

**Turn 14** (actions: none)
  - FAIL [action_match]: Expected one of ['SEND_MESSAGE'], got []. No match

### L1-007: Numerical recall (basic, a10_p8_m0)

**Turn 7** (actions: none)
  - FAIL [action_match]: Expected one of ['REPLY'], got []. No match
  - FAIL [text_contains]: '23' not found in response: '...'
  - FAIL [text_contains]: '3' not found in response: '...'

### L1-008: Implicit reference resolution (basic, a10_p8_m0)

**Turn 2** (actions: none)
  - FAIL [action_match]: Expected one of ['SEND_MESSAGE'], got []. No match

### L1-010: Action momentum (basic, a10_p8_m0)

**Turn 3** (actions: none)
  - FAIL [action_match]: Expected one of ['SEND_MESSAGE'], got []. No match

### L1-013: Time sensitivity (basic, a10_p8_m0)

**Turn 0** (actions: none)
  - FAIL [action_match]: Expected one of ['SCHEDULE_FOLLOW_UP'], got []. No match

**Turn 1** (actions: none)
  - FAIL [action_match]: Expected one of ['REPLY'], got []. No match

**Turn 2** (actions: none)
  - FAIL [action_match]: Expected one of ['REPLY'], got []. No match
  - FAIL [text_contains]: '9' not found in response: '...'

### L1-014: Handling ambiguity then learning (basic, a10_p8_m0)

**Turn 0** (actions: none)
  - FAIL [action_match]: Expected one of ['REPLY'], got []. No match

**Turn 1** (actions: none)
  - FAIL [action_match]: Expected one of ['SEND_MESSAGE'], got []. No match

**Turn 2** (actions: none)
  - FAIL [action_match]: Expected one of ['SEND_MESSAGE'], got []. No match
  - FAIL [text_contains]: 'Alice' not found in response: '...'

### L2-001: Full contact workflow (basic, a10_p8_m0)

**Turn 0** (actions: none)
  - FAIL [action_match]: Expected one of ['ADD_CONTACT'], got []. No match
  - FAIL [action_match]: Expected one of ['SEND_MESSAGE'], got []. No match
  - FAIL [action_match]: Expected one of ['SCHEDULE_FOLLOW_UP'], got []. No match
