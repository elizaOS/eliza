# 14038 — wake-status readiness-signal probe runs (real server lane)

Harness: `14038-wake-signal-probe.mjs` (+ `14038-wake-signal-mock-openai.mjs`), run against
the shipped server lane — `bun packages/app-core/dist/entry.js start` with
`ELIZA_HEADLESS=1`, a fresh `ELIZA_STATE_DIR`, and an OpenAI-compatible mock provider on
`127.0.0.1:18099` so the boot registers a REAL TEXT_GENERATION handler and produces real
end-to-end replies (no external keys). The probe polls `GET /api/health` and
`GET /api/status` every 250ms and concurrently drives a real chat send
(`POST /api/conversations` + `/messages`) from the first moment HTTP accepts.

Set `PROBE_ROOT=<repo checkout>` and run `node 14038-wake-signal-probe.mjs` from a scratch
directory; it writes `timeline.json` + `agent-boot.log` beside itself.

## BEFORE (develop e6637aca28) — `14038-wake-signal-timeline-baseline.json`

```
HTTP accepting (API bound):        6.51s
first chat reply (any):            11.49s   "This agent has no LLM provider configured. Set ANTHROPIC_API_KEY, ..."  <-- WRONG answer to a real turn (key WAS set)
second no-provider reply:          12.35s
/api/health ready=true:            11.53s   (canRespond still false — signals bracket readiness)
/api/status state=running:         11.57s   (canRespond still false)
/api/status canRespond=true:       13.14s   <-- +1.65s AFTER the agent started answering chat
first MODEL-backed chat reply:     14.42s
```

The warming gate released chat turns at `state=running` while all model-provider plugins
were still in the deferred wave: the agent answered — wrongly — while the polled readiness
signal said not-ready, and `canRespond` lagged until the deferred provider registered.

## AFTER (this fix) — `14038-wake-signal-timeline-fixed.json`

```
HTTP accepting (API bound):        8.75s
/api/health ready=true:            15.63s   (ready AND canRespond flip in the SAME transition)
first chat reply (any):            15.84s   <-- model-backed on the FIRST reply; zero no-provider replies
first MODEL-backed chat reply:     15.85s
/api/status state=running:         15.99s   (canRespond true in the SAME transition — never running/canRespond:false)
/api/status canRespond=true:       15.99s
GAP chat-replied -> canRespond:    0.14s    (within one 250ms probe tick; launcher polls at 1500ms)
```

Boot log confirms the mechanism: `[boot] configured provider plugin @elizaos/plugin-openai
loaded before runtime initialization`, `Plugin resolution phase=blocking: 3/17 plugin(s)
selected` (sql, local-inference, openai), `phase=deferred: 14/17` (provider excluded from
the deferred wave — no double registration; action-collision warnings identical to
baseline: 29 = 29).

There is no longer any window where the agent answers chat while the polled readiness
signal reads not-ready, and the "no LLM provider configured" wrong answer during warm-up
is gone.

[core-brain]
