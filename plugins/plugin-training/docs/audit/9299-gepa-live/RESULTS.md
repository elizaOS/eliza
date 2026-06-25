# LifeOps GEPA live optimization — gpt-oss-120b (#9299 Scope 5)

Live before/after results from `scripts/lifeops-gepa-seed.ts` running the real
GEPA loop (`runGepa` + `scoreLifeOpsTask`) over the curated seed datasets, graded
by **gpt-oss-120b** — the model the issue targets.

## Model / provider note

The issue specifies **gpt-oss-120b on Cerebras**. No `CEREBRAS_API_KEY` is present
on this machine, so the run used the **identical `gpt-oss-120b` weights served by
Together AI** (an OpenAI-compatible relay) via the adapter's `CEREBRAS_BASE_URL`
override. Same model, same seed harness, same persistence path — only the
transport endpoint differs. Re-run on Cerebras by unsetting `CEREBRAS_BASE_URL`
and setting a real `CEREBRAS_API_KEY`:

```bash
TRAIN_MODEL_PROVIDER=cerebras CEREBRAS_API_KEY=$XAI_API_KEY \
  CEREBRAS_BASE_URL=https://api.together.xyz/v1 CEREBRAS_MODEL=openai/gpt-oss-120b \
  bun run --cwd plugins/plugin-training scripts/lifeops-gepa-seed.ts -- \
    --task <calendar_extract|inbox_triage|schedule_plan> --generations 2 --population 4 --apply
```

A `fetchChatWithRetry` wrapper (added in this PR) was required to carry the
many-call optimizer through transient `500`s that serverless gpt-oss-120b relays
intermittently return.

## Before / after (live, gen=2 population=4)

| Task | Baseline | Optimized | Δ | Persisted |
| --- | --- | --- | --- | --- |
| `calendar_extract` | 0.795 | 0.864 | **+0.068** | `optimized-prompts/calendar_extract/v1.json` |
| `inbox_triage` | 0.625 | 0.667 | **+0.042** | `optimized-prompts/inbox_triage/v1.json` |
| `schedule_plan` | 0.773 | 0.955 | **+0.182** | `optimized-prompts/schedule_plan/v1.json` |

All three seed tasks improved against gpt-oss-120b; `schedule_plan` (which carries
multilingual FR/ES formal/informal rows) gained the most (+0.182).

The optimized prompts auto-load at boot via `OptimizedPromptService` from the
state-dir optimized-prompt store (`~/.local/state/eliza/optimized-prompts/<task>/v1.json`);
a copy of each artifact + the raw run log is captured alongside this file as
human-verifiable evidence.

### `calendar_extract` — what GEPA changed (sample)

The optimizer kept the working baseline and added a concrete day-window rule and
a `queries` always-present clarification — exactly the kind of small structural
nudge that helps a strong model emit valid JSON without changing intent:

- **+ "Special rule for feed":** "today" → `timeMin` = 00:00 of the current day,
  `timeMax` = 00:00 of the next day (ISO 8601); analogous for "tomorrow".
- **`queries`** annotated as "always present, use `[]` when no queries".

Full prompts + lineage in `calendar_extract.optimized.json`; raw run in
`calendar_extract.run.log`.
