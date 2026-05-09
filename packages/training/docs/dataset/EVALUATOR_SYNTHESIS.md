# Evaluator synthesis spec — closing the Phase 4 gap

The runtime makes one structured LLM call for all registered evaluator items
that pass their `shouldRun()` gate. That's the `purpose: "evaluation"` slice
owned by `EvaluatorService`. The corpus needs coverage for the merged
post-turn output object and each registered evaluator section.

This doc specifies what to synthesize for each evaluator section. Output
target: **~3k records per section**, lifting Phase 4 from <0.1% of the
corpus to ~3%.

Implementation: extend `scripts/synthesize_core_prompts.py` (or add
`scripts/synthesize_evaluator_prompts.py`) to generate one JSONL per
template using the spec below.

---

## Common record shape

Every evaluator record is a canonical `ElizaRecord` (see `SCHEMA.md`):

```jsonc
{
  "roomName":     "<unique id>",
  "agentId":      "<agent id>",
  "memoryEntries": [<recent turns the evaluator sees>],
  "currentMessage": <last user turn>,
  "expectedResponse": "<TOON-or-JSON output the evaluator must emit>",
  "availableActions": [],
  "metadata": {
    "task_type":      "<see per-evaluator below>",
    "source_dataset": "synth-evaluator-<name>",
    "license":        "synthetic",
    "split":          "train" | "validation",
    "synth_task":     "<evaluator name>",
    "teacher_model":  "claude-opus-4-7"
  }
}
```

The only field that differs across evaluators is `expectedResponse`
shape and `task_type`. The trainer renders `task_type` into the system
template registry, so it must match the evaluator's prompt template.

---

## 1. `post_turn_evaluator` — registered evaluator sections (TOON)

Template sections live on the registered evaluator items in
`packages/core/src/features/advanced-capabilities/evaluators/reflection-items.ts`.

**task_type**: `post_turn_evaluator`

**Input window** the synthesizer must build:
- `entitiesInRoom` — 2-5 fake entities with stable UUIDs
- `existingRelationships` — 0-3 prior entries
- `recentMessages` — 4-12 turn snippet
- `actionResults` — JSON array of 0-2 prior action outcomes

**Expected output (JSON)**:
```json
{
  "factMemory": {"ops": []},
  "relationship": {"relationships": []},
  "identity": {"identities": []},
  "success": {
    "completed": true,
    "reason": "The request was completed in the just-finished turn."
  }
}
```

**Status**: corpus already has ~3k records. Top up to 5k with more
diverse `task_completed: false` cases (currently skewed toward `true`).

---

## 2. `reflection` — quality scoring (TOON)

Template: `reflectionTemplate` at `prompts.ts:867`.

**task_type**: `reflection`

**Input window**:
- `providers` — string blob of provider outputs
- `recentInteractions` — recent message turns

**Expected output (TOON)**:
```toon
thought: <detailed analysis>
quality_score: 0-100
strengths: <what went well>
improvements: <what could be improved>
learnings: <key takeaways for future interactions>
```

**Status**: ~2k records exist. Top up to 5k.

---

## 3. `fact_extractor` — durable+current fact ops (JSON)

Template: `factExtractionTemplate` at `prompts.ts:752`.

**task_type**: `fact_extractor`

**Input window**:
- `agentName`, `senderName`, `senderId`
- `now` (ISO timestamp)
- `recentMessages` — 4-12 turns
- `knownDurable` / `knownCurrent` — synthetic prior fact lists with
  fake `factId`s
- `message` — the latest user message (the one being extracted from)

**Expected output (JSON, NOT TOON)** — note this evaluator emits raw
JSON, not TOON:
```json
{"ops": [
  {"op": "add_durable",  "claim": "...", "category": "identity|health|relationship|life_event|business_role|preference|goal", "structured_fields": {...}},
  {"op": "add_current",  "claim": "...", "category": "feeling|physical_state|working_on|going_through|schedule_context", "structured_fields": {...}},
  {"op": "strengthen",   "factId": "fact_abc", "reason": "..."},
  {"op": "decay",        "factId": "fact_abc", "reason": "..."},
  {"op": "contradict",   "factId": "fact_abc", "proposedText": "...", "reason": "..."}
]}
```

**Distribution targets** (3k records):
- 30% `add_durable` (split across 7 categories)
- 30% `add_current` (split across 5 categories)
- 15% `strengthen` (paraphrase of a prior fact)
- 5%  `decay`
- 5%  `contradict`
- 15% empty `{"ops": []}` — small talk / questions / no new facts

**Why empty cases matter**: the template explicitly says "Empty output
is the right answer most of the time." If the corpus only ships
non-empty examples, the model will hallucinate facts on every turn.

**SCHEMA.md update needed**: add row
```
| `fact_extractor` | RAW JSON: `{"ops":[...]}` |
```

---

## 4. `relationship` — relationships only (JSON section)

Template section: `relationshipEvaluator` in `reflection-items.ts`. The
synthesizer emits only the `relationship` top-level section for this task.

**task_type**: `post_turn_evaluator`

Do not emit a separate relationship-extraction task type. Relationship data is
one section of the unified post-turn evaluator object.

---

## 5. `summarization` — conversation summary (TOON)

Template: `initialSummarizationTemplate` at `prompts.ts:254`.

**task_type**: `summarization`

**Input window**:
- `recentMessages` — 8-30 turns (longer than other evaluators)

**Expected output (TOON)**:
```toon
text: <comprehensive summary, < 2500 tokens>
topics[0]: <topic1>
topics[1]: <topic2>
keyPoints[0]: <first key point>
keyPoints[1]: <second key point>
```

**Distribution targets** (3k records):
- 40% short conversations (8-12 turns, 1-3 topics, 2-4 keyPoints)
- 40% medium (12-20 turns, 3-5 topics, 4-7 keyPoints)
- 20% long (20-30 turns, 5+ topics, 7-10 keyPoints)

**SCHEMA.md update needed**:
```
| `summarization` | TOON: `text`, `topics[N]`, `keyPoints[M]` |
```

---

## 6. `long_term_extraction` — episodic/semantic/procedural (TOON)

Template: `longTermExtractionTemplate` at `prompts.ts:285`.

**task_type**: `long_term_extraction`

**Input window**:
- `recentMessages` — 12-40 turns (the evaluator inspects long history)
- `existingMemories` — synthetic prior memory list

**Expected output (TOON)**:
```toon
memories[0]:
  category: episodic | semantic | procedural
  content: <persistent claim>
  confidence: 0.85-1.0   # template requires >= 0.85
memories[1]:
  category: ...
  content: ...
  confidence: ...
```

**Critical distribution requirement** — the template is ULTRA-STRICT:
"If there are no qualifying facts (which is common), return no
memories entries."

**Distribution targets** (3k records):
- 60% **empty** output (no memories) — represents typical conversations
- 25% 1-2 memories with confidence 0.85-0.94
- 15% 2-3 memories with confidence 0.95-1.0

If we synthesize without the empty-case majority, the model will
extract from every turn — defeating the gate.

**SCHEMA.md update needed**:
```
| `long_term_extraction` | TOON: `memories[N]{category,content,confidence}`, may be empty |
```

---

## 7. `skill_extraction` / `skill_refinement` — defer

These come from the advanced-capabilities plugin and have less
documented templates in core. Defer until the plugin's prompts are
stabilized in core. Do not synthesize blind.

**Action**: track as P2 follow-up. Audit
`eliza/packages/plugin-advanced-capabilities/` for the actual
templates before authoring synthesizers.

---

## Synthesizer implementation outline

Single script `scripts/synthesize_evaluator_prompts.py`:

```python
#!/usr/bin/env python3
"""Generate synthetic Phase-4 evaluator records via Opus 4.7."""

EVALUATORS = {
    "post_turn_evaluator": {...},
    "reflection":           {...},
    "fact_extractor":       {...},
    "summarization":        {...},
    "long_term_extraction": {...},
}

# For each evaluator:
#   1) Build a synthetic context window (entities, prior facts, messages)
#   2) Render the template with the context
#   3) Send to teacher model with a fixed system prompt
#   4) Parse output, validate against the schema for that task_type
#   5) Wrap as canonical ElizaRecord and append to JSONL

OUTPUT_DIR = ROOT / "data/synthesized/evaluators/"
TARGET_PER_EVALUATOR = 3000
```

Output files:
- `data/synthesized/evaluators/post_turn_evaluator.jsonl`
- `data/synthesized/evaluators/reflection.jsonl`
- `data/synthesized/evaluators/fact_extractor.jsonl`
- `data/synthesized/evaluators/summarization.jsonl`
- `data/synthesized/evaluators/long_term_extraction.jsonl`

After synthesis, run:
```bash
uv run python scripts/audit_pipeline_shapes.py --only synthesized/evaluators
uv run python scripts/classify_records_by_phase.py --input data/final/train.jsonl
```

The classifier should now show non-zero `Phase 4` totals across
multiple `task_type` values.

---

## Validation gate

Before merging the new synth files into the pack, all three must hold:

1. `audit_pipeline_shapes.py` reports 0 violations on the new records.
2. `classify_records_by_phase.py` tags every new record as Phase 4.
3. Empty-case distribution matches the targets above (40-60% for
   `long_term_extraction`, 15% for `fact_extractor`, 0% for the
   reflection/summarization synthesizers).

The empty-case check lives in `audit_pipeline_shapes.py` as a
distribution gate — fail the build if a synthesizer emits zero empty
cases.
