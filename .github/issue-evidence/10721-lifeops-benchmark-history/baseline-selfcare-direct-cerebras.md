# LifeOps Prompt Benchmark

Provider: **cerebras** · accuracy **70.0%** (7/10) · weighted **70.0%**
Null-case false positive rate: **0.0%** · trajectory capture **100.0%**
Latency: avg 4409ms · p50 4309ms · p95 7199ms

## By Suite

| Suite | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| lifeops-capability-coverage | 7 | 8 | 87.5% |
| lifeops-self-care | 0 | 2 | 0.0% |

## By Task

| Task | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| calendar_extract | 1 | 1 | 100.0% |
| health_checkin | 1 | 1 | 100.0% |
| inbox_triage | 1 | 1 | 100.0% |
| meeting_prep | 1 | 1 | 100.0% |
| morning_brief | 1 | 1 | 100.0% |
| reminder_dispatch | 0 | 3 | 0.0% |
| schedule_plan | 1 | 1 | 100.0% |
| screentime_recap | 1 | 1 | 100.0% |

## By Variant

| Variant | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| direct | 7 | 10 | 70.0% |

## Failures

- `lifeops-capability.reminder_dispatch__direct` expected `OWNER_REMINDERS` but saw `OWNER_ROUTINES`
- `workout-blocker-basic__direct` expected `LIFE` but saw `OWNER_ROUTINES_CREATE`
- `stretch-breaks__direct` expected `LIFE` but saw `SCHEDULED_TASKS_CREATE`
