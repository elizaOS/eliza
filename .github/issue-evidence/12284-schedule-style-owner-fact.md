# #12284 WI-5 — scheduleStyle/chronotype owner-fact from schedule-insight regularity

Phase-by-phase transcript from driving the REAL production writer
(`learnScheduleStyleFromEpisodes`, `plugins/plugin-personal-assistant/src/lifeops/owner/schedule-style-writer.ts`)
over the real `OwnerFactStore` (in-memory runtime cache). No facts are
hand-set in the assertion path; every entry below is produced by the writer
from synthesized sleep-episode histories, classified by plugin-health's real
`computeSleepRegularity` / `computePersonalBaseline`.

Personas: irregular (8 chaotic nights), regular (10x 23:00-07:00), rotating
(4-night block + 4-day block shift pattern), and a user-owned `first_run`
override the learner must not clobber. The idempotent re-run shows an
unchanged classification writes nothing.

Captured 2026-07-04 on branch `feat/12284-travel-schedulestyle` (harness:
vitest spec calling the production modules; transcript verbatim).

```
[phase] learnScheduleStyleFromEpisodes (irregular persona, 8 chaotic nights)
[result] {"wrote":true,"updated":["scheduleStyle","chronotype"],"scheduleStyle":"irregular","chronotype":"intermediate"}
[result idempotent re-run] {"wrote":false,"updated":[],"scheduleStyle":"irregular","chronotype":"intermediate"}
=== fact store @ irregular persona ===
{
  "scheduleStyle": {
    "value": "irregular",
    "provenance": {
      "source": "agent_inferred",
      "recordedAt": "2026-07-10T12:00:00.000Z",
      "note": "learned from observed sleep regularity (schedule insight)"
    }
  },
  "chronotype": {
    "value": "intermediate",
    "provenance": {
      "source": "agent_inferred",
      "recordedAt": "2026-07-10T12:00:00.000Z",
      "note": "learned from observed sleep regularity (schedule insight)"
    }
  }
}
[phase] learnScheduleStyleFromEpisodes (regular persona, 10x 23:00-07:00)
[result] {"wrote":true,"updated":["scheduleStyle","chronotype"],"scheduleStyle":"regular","chronotype":"intermediate"}
=== fact store @ regular persona ===
{
  "scheduleStyle": {
    "value": "regular",
    "provenance": {
      "source": "agent_inferred",
      "recordedAt": "2026-07-10T12:00:00.000Z",
      "note": "learned from observed sleep regularity (schedule insight)"
    }
  },
  "chronotype": {
    "value": "intermediate",
    "provenance": {
      "source": "agent_inferred",
      "recordedAt": "2026-07-10T12:00:00.000Z",
      "note": "learned from observed sleep regularity (schedule insight)"
    }
  }
}
[phase] learnScheduleStyleFromEpisodes (rotating persona, 4 night-block + 4 day-block)
[result] {"wrote":true,"updated":["scheduleStyle"],"scheduleStyle":"rotating","chronotype":null}
=== fact store @ rotating persona ===
{
  "scheduleStyle": {
    "value": "rotating",
    "provenance": {
      "source": "agent_inferred",
      "recordedAt": "2026-07-10T12:00:00.000Z",
      "note": "learned from observed sleep regularity (schedule insight)"
    }
  }
}
[phase] user-owned override (first_run scheduleStyle=regular, then chaotic evidence)
[result] {"wrote":true,"updated":["chronotype"],"scheduleStyle":"irregular","chronotype":"intermediate"}
=== fact store @ user-owned override ===
{
  "scheduleStyle": {
    "value": "regular",
    "provenance": {
      "source": "first_run",
      "recordedAt": "2026-07-01T00:00:00.000Z"
    }
  },
  "chronotype": {
    "value": "intermediate",
    "provenance": {
      "source": "agent_inferred",
      "recordedAt": "2026-07-10T12:00:00.000Z",
      "note": "learned from observed sleep regularity (schedule insight)"
    }
  }
}
```
