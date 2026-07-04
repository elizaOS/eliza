## LifeOpsBench eliza-agent static — before/after deltas

- before: 34 scenarios from ['core-static/lifeops_gemma-4-31b_20260704_173927.json', 'f1-controls/lifeops_gemma-4-31b_20260704_174039.json', 'f1-controls/lifeops_gemma-4-31b_20260704_174140.json', 'f1-controls/lifeops_gemma-4-31b_20260704_174230.json', 'f1-controls/lifeops_gemma-4-31b_20260704_174313.json', 'f1-controls/lifeops_gemma-4-31b_20260704_174342.json', 'f1-controls/lifeops_gemma-4-31b_20260704_174405.json', 'f1-controls/lifeops_gemma-4-31b_20260704_174420.json', 'f1-controls/lifeops_gemma-4-31b_20260704_174519.json'], model(s) ['gemma-4-31b']
- after: 34 scenarios from ['core-static/lifeops_gemma-4-31b_20260704_172258.json', 'f1-controls/lifeops_gemma-4-31b_20260704_172417.json', 'f1-controls/lifeops_gemma-4-31b_20260704_172451.json', 'f1-controls/lifeops_gemma-4-31b_20260704_172523.json', 'f1-controls/lifeops_gemma-4-31b_20260704_172602.json', 'f1-controls/lifeops_gemma-4-31b_20260704_172645.json', 'f1-controls/lifeops_gemma-4-31b_20260704_172725.json', 'f1-controls/lifeops_gemma-4-31b_20260704_172806.json', 'f1-controls/lifeops_gemma-4-31b_20260704_172915.json'], model(s) ['gemma-4-31b']
- before pass@1 [core-static/lifeops_gemma-4-31b_20260704_173927.json]: 0.038
- before pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_174039.json]: 0.000
- before pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_174140.json]: 0.000
- before pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_174230.json]: 0.000
- before pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_174313.json]: 0.000
- before pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_174342.json]: 0.000
- before pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_174405.json]: 0.000
- before pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_174420.json]: 0.000
- before pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_174519.json]: 0.000
- after pass@1 [core-static/lifeops_gemma-4-31b_20260704_172258.json]: 0.038
- after pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_172417.json]: 0.000
- after pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_172451.json]: 0.000
- after pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_172523.json]: 0.000
- after pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_172602.json]: 0.000
- after pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_172645.json]: 0.000
- after pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_172725.json]: 0.000
- after pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_172806.json]: 0.000
- after pass@1 [f1-controls/lifeops_gemma-4-31b_20260704_172915.json]: 0.000

### Per-domain mean score

| domain | before (n) | after (n) | delta |
|---|---|---|---|
| calendar | 0.357 (7) | 0.357 (7) | +0.000 |
| contacts | 0.133 (3) | 0.133 (3) | +0.000 |
| finance | 0.000 (2) | 0.000 (2) | +0.000 |
| focus | 0.100 (2) | 0.100 (2) | +0.000 |
| health | 0.000 (4) | 0.000 (4) | +0.000 |
| mail | 0.367 (3) | 0.367 (3) | +0.000 |
| messages | 0.067 (3) | 0.067 (3) | +0.000 |
| reminders | 0.225 (6) | 0.225 (6) | +0.000 |
| sleep | 0.000 (2) | 0.000 (2) | +0.000 |
| travel | 0.450 (2) | 0.450 (2) | +0.000 |

### F1 neurotypical-control static canary (per scenario)

| scenario | before | after | delta |
|---|---|---|---|
| control.calendar.family_soccer_pickup_event | 0.200 | 0.200 | +0.000 |
| control.calendar.reschedule_launch_checklist_plain_default | 0.000 | 0.000 | +0.000 |
| control.calendar.school_events_plain_start_time_preference | 0.000 | 0.000 | +0.000 |
| control.contacts.add_coach_lena_basic_contact | 0.200 | 0.200 | +0.000 |
| control.health.steps_today_no_unsolicited_coaching | 0.000 | 0.000 | +0.000 |
| control.reminders.plain_daily_reminder_no_scaffolding | 0.000 | 0.000 | +0.000 |
| control.reminders.preview_then_confirm_bright_smile_call | 0.900 | 0.900 | +0.000 |
| control.reminders.simple_allergy_medicine_pickup | 0.000 | 0.000 | +0.000 |

**F1 canary verdict: NO REGRESSION**

### Scenario movement: common=34 improved=0 regressed=0

