# LifeOps Prompt Benchmark

Provider: **cerebras** · accuracy **22.6%** (90/398) · weighted **28.9%**
Null-case false positive rate: **6.3%** · trajectory capture **85.9%**
Latency: avg 3964ms · p50 3765ms · p95 8530ms

## By Suite

| Suite | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| lifeops-capability-coverage | 6 | 8 | 75.0% |
| lifeops-executive-assistant | 56 | 200 | 28.0% |
| lifeops-self-care | 28 | 190 | 14.7% |

## By Task

| Task | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| calendar_extract | 10 | 22 | 45.5% |
| health_checkin | 3 | 21 | 14.3% |
| inbox_triage | 3 | 38 | 7.9% |
| meeting_prep | 1 | 1 | 100.0% |
| morning_brief | 20 | 51 | 39.2% |
| reminder_dispatch | 50 | 253 | 19.8% |
| schedule_plan | 2 | 11 | 18.2% |
| screentime_recap | 1 | 1 | 100.0% |

## By Variant

| Variant | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| adult-formal | 7 | 39 | 17.9% |
| broken-english | 4 | 39 | 10.3% |
| childlike | 5 | 39 | 12.8% |
| direct | 11 | 47 | 23.4% |
| distracted-rambling | 4 | 39 | 10.3% |
| expert-shorthand | 8 | 39 | 20.5% |
| naive-underspecified | 6 | 39 | 15.4% |
| self-correcting | 5 | 39 | 12.8% |
| subtle-null | 36 | 39 | 92.3% |
| voice-asr | 4 | 39 | 10.3% |

## Failures

- `lifeops-capability.reminder_dispatch__direct` expected `OWNER_REMINDERS` but saw `OWNER_ROUTINES_CREATE`
- `lifeops-capability.morning_brief__direct` expected `BRIEF` but saw `null`
- `workout-blocker-basic__direct` expected `LIFE` but saw `BLOCK_BLOCK`
- `workout-blocker-basic__adult-formal` expected `LIFE` but saw `BLOCK_BLOCK`
- `workout-blocker-basic__childlike` expected `LIFE` but saw `BLOCK_BLOCK`
- `workout-blocker-basic__broken-english` expected `LIFE` but saw `BLOCK_BLOCK`
- `workout-blocker-basic__naive-underspecified` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `workout-blocker-basic__expert-shorthand` expected `LIFE` but saw `BLOCK_BLOCK`
- `workout-blocker-basic__distracted-rambling` expected `LIFE` but saw `null`
- `workout-blocker-basic__voice-asr` expected `LIFE` but saw `BLOCK_BLOCK`
- `workout-blocker-basic__self-correcting` expected `LIFE` but saw `BLOCK_BLOCK`
- `stretch-breaks__direct` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `stretch-breaks__adult-formal` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `stretch-breaks__childlike` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `stretch-breaks__broken-english` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `stretch-breaks__naive-underspecified` expected `LIFE` but saw `SCHEDULED_TASKS_CREATE`
- `stretch-breaks__expert-shorthand` expected `LIFE` but saw `null`
- `stretch-breaks__distracted-rambling` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `stretch-breaks__voice-asr` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `stretch-breaks__self-correcting` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`

