"""Per-source structural rewriters for the v8 training corpus.

Each module exports a `rewrite(record, *, decoder, encoder) -> dict | None`
that consumes one canonical eliza record from `data/final/train.jsonl` and
returns a corrected record (or `None` if it cannot be rewritten cleanly).

The rewriters operate on the already-packed records and emit a corrected
native JSON `expectedResponse`. They fix:

  - openclaw-operator: text was JSON [{name, arguments}, ...] → tool_call (or reply when natural-language)
  - nubilio-trajectories: system prompt baked in → split sub-task and relocate prompt
  - regularizer-reasoning-tool: CoT thought without grounded fields → reasoning_cot
  - agent-trove: text was JSON {analysis, plan, ...} → keep plan as text

See `PER_SOURCE_NATIVE_JSON_AUDIT.md` for context.
"""

from __future__ import annotations
