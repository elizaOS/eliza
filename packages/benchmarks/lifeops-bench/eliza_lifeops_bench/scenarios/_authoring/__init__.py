"""Scenario candidate generator pipeline.

Operator workflow:

1. ``python -m eliza_lifeops_bench.scenarios._authoring.generate_candidates
   --domain calendar --n 20 --output candidates/calendar_batch_001.json``
   - Calls Cerebras gpt-oss-120b with the spec, the action manifest, the
     world snapshot, and a sample of hand-authored scenarios as seed
     prompts. Validates each candidate; only valid ones land in JSON.
2. Human reviews ``candidates/calendar_batch_001.json``, deletes anything
   bad, optionally hand-tweaks fields.
3. ``python -m eliza_lifeops_bench.scenarios._authoring.import_reviewed
   candidates/calendar_batch_001.json --domain calendar`` — appends the
   approved candidates to ``scenarios/calendar.py``.

The pipeline never auto-edits scenario modules. Import is a separate,
explicit step so a human is always in the loop between LLM output and
the corpus.
"""

from __future__ import annotations
