## LifeOps prompt benchmark — before/after deltas

- before: provider `cerebras`, generated 2026-07-04T21:12:51.757Z
- after: provider `cerebras`, generated 2026-07-04T21:12:50.308Z

### Overall

| metric | before | after | delta |
|---|---|---|---|
| accuracy | 23.4% | 22.6% | **-0.8pp** |
| weightedAccuracy | 29.5% | 28.9% | **-0.6pp** |
| falsePositiveRate | 6.2% | 6.2% | **+0.0pp** |
| passed/total | 93/398 | 90/398 | |
| latency p50/p95 ms | 3933/10069 | 3765/8530 | |

### By suite

| slice | before acc (n) | after acc (n) | delta |
|---|---|---|---|
| lifeops-capability-coverage | 87.5% (7/8) | 75.0% (6/8) | **-12.5pp** |
| lifeops-executive-assistant | 29.0% (58/200) | 28.0% (56/200) | **-1.0pp** |
| lifeops-self-care | 14.7% (28/190) | 14.7% (28/190) | **+0.0pp** |

### By task

| slice | before acc (n) | after acc (n) | delta |
|---|---|---|---|
| calendar_extract | 54.5% (12/22) | 45.5% (10/22) | **-9.1pp** |
| health_checkin | 14.3% (3/21) | 14.3% (3/21) | **+0.0pp** |
| inbox_triage | 5.3% (2/38) | 7.9% (3/38) | **+2.6pp** |
| meeting_prep | 100.0% (1/1) | 100.0% (1/1) | **+0.0pp** |
| morning_brief | 47.1% (24/51) | 39.2% (20/51) | **-7.8pp** |
| reminder_dispatch | 19.0% (48/253) | 19.8% (50/253) | **+0.8pp** |
| schedule_plan | 18.2% (2/11) | 18.2% (2/11) | **+0.0pp** |
| screentime_recap | 100.0% (1/1) | 100.0% (1/1) | **+0.0pp** |

### By risk class

| slice | before acc (n) | after acc (n) | delta |
|---|---|---|---|
| edge | 11.1% (21/190) | 9.5% (18/190) | **-1.6pp** |
| null | 93.8% (45/48) | 93.8% (45/48) | **+0.0pp** |
| positive | 16.9% (27/160) | 16.9% (27/160) | **+0.0pp** |

### By variant

| slice | before acc (n) | after acc (n) | delta |
|---|---|---|---|
| adult-formal | 17.9% (7/39) | 17.9% (7/39) | **+0.0pp** |
| broken-english | 10.3% (4/39) | 10.3% (4/39) | **+0.0pp** |
| childlike | 17.9% (7/39) | 12.8% (5/39) | **-5.1pp** |
| direct | 25.5% (12/47) | 23.4% (11/47) | **-2.1pp** |
| distracted-rambling | 7.7% (3/39) | 10.3% (4/39) | **+2.6pp** |
| expert-shorthand | 12.8% (5/39) | 20.5% (8/39) | **+7.7pp** |
| naive-underspecified | 17.9% (7/39) | 15.4% (6/39) | **-2.6pp** |
| self-correcting | 12.8% (5/39) | 12.8% (5/39) | **+0.0pp** |
| subtle-null | 92.3% (36/39) | 92.3% (36/39) | **+0.0pp** |
| voice-asr | 17.9% (7/39) | 10.3% (4/39) | **-7.7pp** |

### Case-level movement (matched case ids)

- common cases: 398 (before-only: 0, after-only: 0)
- improved (fail→pass): 12
- regressed (pass→fail): 15

Regressed case ids:
- `ea.docs.signature-before-appointment__adult-formal`
- `ea.events.itinerary-brief-with-links__naive-underspecified`
- `ea.inbox.daily-brief-cross-channel__broken-english`
- `ea.inbox.daily-brief-cross-channel__childlike`
- `ea.inbox.daily-brief-cross-channel__self-correcting`
- `ea.inbox.daily-brief-cross-channel__voice-asr`
- `ea.push.multi-device-meeting-ladder__distracted-rambling`
- `ea.push.multi-device-meeting-ladder__voice-asr`
- `ea.schedule.bundle-meetings-while-traveling__childlike`
- `ea.schedule.bundle-meetings-while-traveling__naive-underspecified`
- `ea.schedule.bundle-meetings-while-traveling__voice-asr`
- `ea.schedule.travel-blackout-reschedule__direct`
- `ea.schedule.travel-blackout-reschedule__self-correcting`
- `ea.travel.book-after-approval__childlike`
- `lifeops-capability.morning_brief__direct`

