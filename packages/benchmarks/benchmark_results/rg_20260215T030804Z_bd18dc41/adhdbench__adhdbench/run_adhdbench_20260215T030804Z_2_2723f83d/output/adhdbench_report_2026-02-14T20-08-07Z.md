# ADHDBench Report

**Model**: qwen/qwen3-32b
**Provider**: groq
**Timestamp**: 2026-02-14T20:08:07Z
**Total Scenarios Run**: 38
**Duration**: 615ms

## Baselines

| Baseline | Score |
|----------|-------|
| random | 57.4% |
| always_reply | 69.3% |

## Attention Scaling Curves

### Config: basic

```
  Attention Scaling Curve (basic)

   100% |                
    90% |                
    80% |                
    70% |                
    60% |                
    50% |  ##        ##  
    40% |  ##        ##  
    30% |  ##        ##  
    20% |  ##        ##  
    10% |  ##        ##  
     0% |  ##        ##  
        +---------------
          a10_p8_m0   a50_p18_m30
```

| Scale Point | Actions | Providers | Prefill | Score | Latency (ms) | Scenarios |
|-------------|---------|-----------|---------|-------|-------------|-----------|
| a10_p8_m0 | 10 | 8 | 0 | 57.4% | 6 | 19 |
| a50_p18_m30 | 50 | 18 | 30 | 57.4% | 16 | 19 |

## Per-Level Breakdown

| Config/Level | Scale Point | Avg Score | Count |
|-------------|-------------|-----------|-------|
| basic/ACTION_DISPATCH | a10_p8_m0 | 57.4% | 19 |
| basic/ACTION_DISPATCH | a50_p18_m30 | 57.4% | 19 |

## Lowest Scoring Scenarios

| Scenario | Config | Scale | Score | Error |
|----------|--------|-------|-------|-------|
| L0-001: Simple time question | basic | a10_p8_m0 | 50.0% | - |
| L0-006: Ignore meta-communication | basic | a10_p8_m0 | 50.0% | - |
| L0-008: Follow room | basic | a10_p8_m0 | 50.0% | - |
| L0-011: Update role | basic | a10_p8_m0 | 50.0% | - |
| L0-013: Unfollow room | basic | a10_p8_m0 | 50.0% | - |
| L0-014: Add contact | basic | a10_p8_m0 | 50.0% | - |
| L0-016: Update settings | basic | a10_p8_m0 | 50.0% | - |
| L0-017: Unmute room | basic | a10_p8_m0 | 50.0% | - |
| L0-018: Reset session | basic | a10_p8_m0 | 50.0% | - |
| L0-019: Update contact info | basic | a10_p8_m0 | 50.0% | - |
| L0-001: Simple time question | basic | a50_p18_m30 | 50.0% | - |
| L0-006: Ignore meta-communication | basic | a50_p18_m30 | 50.0% | - |
| L0-008: Follow room | basic | a50_p18_m30 | 50.0% | - |
| L0-011: Update role | basic | a50_p18_m30 | 50.0% | - |
| L0-013: Unfollow room | basic | a50_p18_m30 | 50.0% | - |
| L0-014: Add contact | basic | a50_p18_m30 | 50.0% | - |
| L0-016: Update settings | basic | a50_p18_m30 | 50.0% | - |
| L0-017: Unmute room | basic | a50_p18_m30 | 50.0% | - |
| L0-018: Reset session | basic | a50_p18_m30 | 50.0% | - |
| L0-019: Update contact info | basic | a50_p18_m30 | 50.0% | - |

## Failed Outcome Details

### L0-001: Simple time question (basic, a10_p8_m0)

**Turn 0** (actions: none)
  - FAIL [action_match]: Expected one of ['REPLY'], got []. No match

### L0-006: Ignore meta-communication (basic, a10_p8_m0)

**Turn 0** (actions: none)
  - FAIL [action_match]: Expected one of ['IGNORE', 'NONE', 'REPLY'], got []. No match

### L0-008: Follow room (basic, a10_p8_m0)

**Turn 0** (actions: none)
  - FAIL [action_match]: Expected one of ['FOLLOW_ROOM'], got []. No match

### L0-011: Update role (basic, a10_p8_m0)

**Turn 0** (actions: none)
  - FAIL [action_match]: Expected one of ['UPDATE_ROLE'], got []. No match

### L0-013: Unfollow room (basic, a10_p8_m0)

**Turn 0** (actions: none)
  - FAIL [action_match]: Expected one of ['UNFOLLOW_ROOM'], got []. No match

### L0-014: Add contact (basic, a10_p8_m0)

**Turn 0** (actions: none)
  - FAIL [action_match]: Expected one of ['ADD_CONTACT'], got []. No match

### L0-016: Update settings (basic, a10_p8_m0)

**Turn 0** (actions: none)
  - FAIL [action_match]: Expected one of ['UPDATE_SETTINGS'], got []. No match

### L0-017: Unmute room (basic, a10_p8_m0)

**Turn 0** (actions: none)
  - FAIL [action_match]: Expected one of ['UNMUTE_ROOM'], got []. No match

### L0-018: Reset session (basic, a10_p8_m0)

**Turn 0** (actions: none)
  - FAIL [action_match]: Expected one of ['RESET_SESSION'], got []. No match

### L0-019: Update contact info (basic, a10_p8_m0)

**Turn 0** (actions: none)
  - FAIL [action_match]: Expected one of ['UPDATE_CONTACT_INFO', 'UPDATE_CONTACT'], got []. No match
