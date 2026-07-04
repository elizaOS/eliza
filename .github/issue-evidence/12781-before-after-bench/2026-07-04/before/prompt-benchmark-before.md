# LifeOps Prompt Benchmark

Provider: **cerebras** · accuracy **23.4%** (93/398) · weighted **29.5%**
Null-case false positive rate: **6.3%** · trajectory capture **86.2%**
Latency: avg 4111ms · p50 3933ms · p95 10069ms

## By Suite

| Suite | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| lifeops-capability-coverage | 7 | 8 | 87.5% |
| lifeops-executive-assistant | 58 | 200 | 29.0% |
| lifeops-self-care | 28 | 190 | 14.7% |

## By Task

| Task | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| calendar_extract | 12 | 22 | 54.5% |
| health_checkin | 3 | 21 | 14.3% |
| inbox_triage | 2 | 38 | 5.3% |
| meeting_prep | 1 | 1 | 100.0% |
| morning_brief | 24 | 51 | 47.1% |
| reminder_dispatch | 48 | 253 | 19.0% |
| schedule_plan | 2 | 11 | 18.2% |
| screentime_recap | 1 | 1 | 100.0% |

## By Variant

| Variant | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| adult-formal | 7 | 39 | 17.9% |
| broken-english | 4 | 39 | 10.3% |
| childlike | 7 | 39 | 17.9% |
| direct | 12 | 47 | 25.5% |
| distracted-rambling | 3 | 39 | 7.7% |
| expert-shorthand | 5 | 39 | 12.8% |
| naive-underspecified | 7 | 39 | 17.9% |
| self-correcting | 5 | 39 | 12.8% |
| subtle-null | 36 | 39 | 92.3% |
| voice-asr | 7 | 39 | 17.9% |

## Failures

- `lifeops-capability.reminder_dispatch__direct` expected `OWNER_REMINDERS` but saw `OWNER_ROUTINES_CREATE`
- `workout-blocker-basic__direct` expected `LIFE` but saw `null`
- `workout-blocker-basic__adult-formal` expected `LIFE` but saw `BLOCK_BLOCK`
- `workout-blocker-basic__childlike` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `workout-blocker-basic__broken-english` expected `LIFE` but saw `BLOCK`
- `workout-blocker-basic__naive-underspecified` expected `LIFE` but saw `BLOCK_BLOCK`
- `workout-blocker-basic__expert-shorthand` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `workout-blocker-basic__distracted-rambling` expected `LIFE` but saw `null`
- `workout-blocker-basic__voice-asr` expected `LIFE` but saw `BLOCK`
- `workout-blocker-basic__self-correcting` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `stretch-breaks__direct` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `stretch-breaks__adult-formal` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `stretch-breaks__childlike` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `stretch-breaks__broken-english` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `stretch-breaks__naive-underspecified` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `stretch-breaks__expert-shorthand` expected `LIFE` but saw `null`
- `stretch-breaks__distracted-rambling` expected `LIFE` but saw `SCHEDULED_TASKS_CREATE`
- `stretch-breaks__voice-asr` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `stretch-breaks__self-correcting` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `goal-sleep-basic__direct` expected `LIFE` but saw `OWNER_GOALS_CREATE`

