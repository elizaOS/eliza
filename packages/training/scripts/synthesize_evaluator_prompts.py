"""Phase-4 (evaluator) datasets in the canonical `eliza_native_v1` shape.

The runtime fires post-turn evaluators that each make their own LLM call,
tagged `purpose: "evaluation"` in trajectory logging (see
`docs/dataset/RUNTIME_PHASES.md` §"Phase 4"):

  - REFLECT             — `reflectionTemplate` (`{thought, quality_score,
                           strengths, improvements, learnings}`)
  - REFLECTION          — the reflection-evaluator variant that also extracts
                           relationship edges (`{thought, task_completed,
                           task_completion_reason, relationships[]}`)
  - FACT_EXTRACTOR      — `factExtractionTemplate` (`{ops:[...]}`)
  - SUMMARIZATION       — `initialSummarizationTemplate` (`{text, topics[],
                           keyPoints[]}`)
  - LONG_TERM_EXTRACTION— `longTermExtractionTemplate` (`{memories:[{category,
                           content, confidence}]}`)
  - RELATIONSHIP_EXTRACTION (facts_and_relationships stage) — the
                           `FACTS_AND_RELATIONSHIPS_VALIDATE` tool call
                           (`{facts:[], relationships:[{subject,predicate,
                           object}], thought}`)
  - SKILL_EXTRACTION    — skillProposal evaluator (`{extract, reason, name?,
                           description?, body?}`)
  - SKILL_REFINEMENT    — skillRefinement evaluator (`{refinements:[{skillName,
                           refine, reason, newBody?}]}`)

Only `reflection` was previously a real corpus file; the legacy ones
(`data/synthesized/evaluators/_backup/*.jsonl`) used the flat `ElizaRecord`
envelope with a TOON `expectedResponse`. This module:

  1. Re-renders the legacy `reflection`, `reflection_evaluator`,
     `fact_extractor`→`fact_extraction`, `summarization`, and
     `long_term_extraction` rows against the *current* runtime templates,
     converting the TOON target to JSON, and writes `eliza_native_v1` rows.
  2. Generates new deterministic `relationship_extraction`, `skill_extraction`,
     and `skill_refinement` rows (~1k each).

Deterministic, no API key.

Run:
    .venv/bin/python scripts/synthesize_evaluator_prompts.py
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.native_record import native_text_record, native_tool_call_record, stable_id, write_jsonl  # noqa: E402
from lib.toon import ToonDecoder  # noqa: E402

EVAL_DIR = ROOT / "data" / "synthesized" / "evaluators"
BACKUP_DIR = EVAL_DIR / "_backup"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("synth-evaluator")

# legacy backup filename -> output task type
LEGACY_MAP = {
    "reflection": "reflection",
    "reflection_evaluator": "reflection_evaluator",
    "fact_extractor": "fact_extraction",
    "summarization": "summarization",
    "long_term_extraction": "long_term_extraction",
}
GENERATED_TASK_TYPES = ["relationship_extraction", "skill_extraction", "skill_refinement"]


# ─── current runtime templates (verbatim from packages/prompts/src/index.ts) ──

REFLECTION_TEMPLATE = """# Task: Reflect on recent agent behavior and interactions.

{{providers}}

# Recent Interactions:
{{recentInteractions}}

# Instructions:
Analyze recent behavior. Consider:
1. Communication clarity and helpfulness
2. Context appropriateness
3. Mistakes
4. Improvements

JSON:
thought: Your detailed analysis
quality_score: Score 0-100 for overall quality
strengths: What went well
improvements: What could be improved
learnings: Key takeaways for future interactions

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
"""

# Reflection-evaluator (relationship-extracting) variant.
REFLECTION_EVALUATOR_TEMPLATE = """# Task: Generate agent reflection and extract relationship edges.

# Entities in Room
{{entities}}

# Existing Relationships
{{existingRelationships}}

# Current Context
Agent Name: {{agentName}}
Room Type: {{roomType}}
Message Sender: {{senderName}} (ID: {{senderId}})

{{recentInteractions}}

# Latest Action Results:
{{actionResults}}

# Instructions:
1. Generate a self-reflective thought on the conversation so far.
2. Decide whether the user's most recent request is complete.
3. Extract relationship edges between the entities in the room based on the interaction (sourceEntityId, targetEntityId, tags).

JSON:
thought: Your reflection
task_completed: true|false
task_completion_reason: One line
relationships[n]:
  sourceEntityId: UUID
  targetEntityId: UUID
  tags[n]: tag

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
"""

FACT_EXTRACTION_TEMPLATE = """# Task: Classify and extract facts from this message

You maintain two fact stores. Decide what to insert, strengthen, decay, or contradict. Return JSON ops only.

Stores:
- durable: stable identity-level claims that matter in a year.
  Categories: identity, health, relationship, life_event, business_role, preference, goal.
- current: time-bound state about now or near term.
  Categories: feeling, physical_state, working_on, going_through, schedule_context.

Rules:
- If a claim feels stale or surprising to retrieve in a year, use current.
- Empty output is right for small talk or claim-free questions.
- Before add_durable/add_current, scan known facts. If meaning exists, emit strengthen with that factId.
- Paraphrases count as duplicates. Match meaning, not surface form.

Ops:
- add_durable: claim, category, structured_fields, keywords; optional verification_status, reason.
- add_current: claim, category, structured_fields, keywords; optional valid_at, reason.
- strengthen: factId, optional reason.
- decay: factId, optional reason.
- contradict: factId, reason, optional proposedText.

For add_durable/add_current, include keywords: 3-8 lowercase retrieval terms.

Inputs:
Agent Name: {{agentName}}
Message Sender: {{senderName}} (ID: {{senderId}})
Now: {{now}}

Recent messages:
{{recentMessages}}

Known durable facts (format: [factId] (durable.category) claim):
{{knownDurable}}

Known current facts (format: [factId] (current.category, since validAt) claim):
{{knownCurrent}}

Latest message:
{{message}}

Output:
JSON only. One JSON object. No prose, fences, thinking, or <think>.
If nothing should change, return:
{"ops":[]}

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
"""

INITIAL_SUMMARIZATION_TEMPLATE = """# Task: Summarize Conversation

Create a concise summary capturing key points, topics, and details.

# Recent Messages
{{recentMessages}}

# Instructions
Generate a summary that:
1. Captures main topics
2. Highlights key information
3. Notes decisions and questions
4. Maintains context for future reference
5. Concise but comprehensive

**Keep summary under 2500 tokens.**

Also extract:
- **Topics**: main topics (comma-separated)
- **Key Points**: important facts or decisions (bullets)

JSON:
text: Your comprehensive summary here
topics[0]: topic1
topics[1]: topic2
keyPoints[0]: First key point
keyPoints[1]: Second key point

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
"""

LONG_TERM_EXTRACTION_TEMPLATE = """# Task: Extract Long-Term Memory (Strict)

Extract ONLY critical, persistent user info using cognitive memory categories.

# Recent Messages
{{recentMessages}}

# Current Long-Term Memories
{{existingMemories}}

# Memory Categories
- EPISODIC: specific completed events with temporal/spatial context (who/what/when/where), significant impact.
- SEMANTIC: stable identity facts (role, title, company, core expertise, primary languages/tools), explicitly stated or conclusively demonstrated.
- PROCEDURAL: workflows, methodologies, how-to — repeated 3+ times or stated as standard practice.

# Quality Gates (ALL must pass)
1. Significance — matters in 3+ months
2. Specificity — concrete and actionable
3. Evidence — 3+ instances OR explicit self-identification
4. Uniqueness — specific to THIS user
5. Confidence >= 0.85
6. Non-Redundancy — not already in existing memories

Default to NOT extracting. Max 2-3 extractions per run. If nothing qualifies (common), return no memories entries.

# Response Format
memories[0]:
  category: semantic
  content: ...
  confidence: 0.95

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.
"""

# facts_and_relationships stage — the FACTS_AND_RELATIONSHIPS_VALIDATE tool call.
FACTS_AND_RELATIONSHIPS_TOOL = "FACTS_AND_RELATIONSHIPS_VALIDATE"
FACTS_AND_RELATIONSHIPS_INSTRUCTIONS = """task: Validate candidate facts and relationships extracted from the latest user message. Persist only what is genuinely new.

rules:
- drop any candidate that is a paraphrase or trivial restatement of an existing fact or relationship
- drop candidates that are speculative, agent-generated, or not stated by the user
- drop credentials, API keys, passwords, raw tokens, and other secrets; never persist their values
- drop synthetic summaries, compaction artifacts, generic chat filler, and one-off task requests
- normalize entity names to match the names already used in existing relationships or room entities when possible (do not invent new aliases)
- relationships use snake_case predicates ("works_with", "lives_in", "manages")
- if every candidate is a duplicate, return empty arrays
- thought is a one-line internal note about the dedup decision"""

SKILL_PROPOSAL_PROMPT = """Evaluate whether this completed trajectory contains a reusable repeatable procedure worth saving as a SKILL.md.

Return extract=false if the run is too narrow, one-off, private, or not procedural.
If extract=true, provide:
- name: lowercase letters, digits, and hyphens only, up to 64 characters.
- description: one sentence, up to 200 characters.
- body: markdown body for the skill, without frontmatter.

Trajectory:
{{trajectory}}"""

SKILL_REFINEMENT_PROMPT = """Evaluate whether the active skills should be refined because this trajectory failed or retried while using them.

Return one refinement object per skill. Set refine=false when no update is warranted.
When refine=true, newBody must be the complete replacement markdown body without frontmatter.
Do not invent capabilities. Tighten steps, add guardrails for the failure mode, and remove ambiguity.

Active skills:
{{skills}}

Trajectory:
{{trajectory}}"""


def _render(template: str, **subs: str) -> str:
    out = template
    for k, v in subs.items():
        out = out.replace("{{" + k + "}}", v)
    # blank any unfilled placeholders
    import re

    out = re.sub(r"\{\{[a-zA-Z_]+\}\}", "(none)", out)
    return out.strip()


# ─── legacy-row conversion helpers ───────────────────────────────────────

_decoder = ToonDecoder()


def _conversation_lines(legacy: dict[str, Any]) -> tuple[str, str, str]:
    raw = legacy.get("agentId", "agent")
    agent_disp = raw[:1].upper() + raw[1:] if raw else "Agent"
    for m in legacy.get("memoryEntries") or []:
        if m.get("role") == "assistant" and m.get("speaker"):
            agent_disp = m["speaker"]
            break
    lines: list[str] = []
    for m in legacy.get("memoryEntries") or []:
        who = m.get("speaker") or (agent_disp if m.get("role") == "assistant" else "user")
        lines.append(f"{who}: {m.get('content', '')}")
    cur = legacy.get("currentMessage") or {}
    lines.append(f"{cur.get('speaker') or 'user'}: {cur.get('content', '')}")
    return "\n".join(lines), cur.get("content", ""), agent_disp


def _decode_target(expected: str) -> Any:
    expected = (expected or "").strip()
    if not expected:
        return {}
    if expected[0] in "[{":
        try:
            return json.loads(expected)
        except json.JSONDecodeError:
            pass
    try:
        return _decoder.decode(expected)
    except Exception:  # noqa: BLE001
        return None


def _as_list(v: Any) -> list[Any]:
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def _json_text(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _meta(legacy: dict[str, Any], task_type: str, origin: str) -> dict[str, Any]:
    src = legacy.get("metadata") or {}
    return {
        "task_type": task_type,
        "source_dataset": f"synth-evaluator-{task_type}",
        "split": src.get("split", "train"),
        "synth_origin": origin,
        "id": stable_id("evaluator", task_type, json.dumps(legacy.get("currentMessage", {}), sort_keys=True),
                        legacy.get("expectedResponse", ""), str(src.get("teacher_model", ""))),
    }


# ─── per-task-type conversions of legacy rows ────────────────────────────

def _convert_reflection(legacy: dict[str, Any], target: Any, recent: str, agent: str) -> dict[str, Any] | None:
    if not isinstance(target, dict):
        return None
    obj = {
        "thought": str(target.get("thought") or ""),
        "quality_score": target.get("quality_score"),
        "strengths": target.get("strengths") or "",
        "improvements": target.get("improvements") or "",
        "learnings": target.get("learnings") or "",
    }
    if obj["quality_score"] is None or not obj["thought"]:
        return None
    system = _render(REFLECTION_TEMPLATE, agentName=agent, providers="(no providers)", recentInteractions=recent)
    return native_text_record(system=system, user=recent, response_text=_json_text(obj),
                              metadata=_meta(legacy, "reflection", "evaluator-converted"))


def _convert_reflection_evaluator(legacy: dict[str, Any], target: Any, recent: str, agent: str) -> dict[str, Any] | None:
    if not isinstance(target, dict):
        return None
    rels = []
    for r in _as_list(target.get("relationships")):
        if not isinstance(r, dict):
            continue
        rels.append({
            "sourceEntityId": r.get("sourceEntityId"),
            "targetEntityId": r.get("targetEntityId"),
            "tags": _as_list(r.get("tags")),
        })
    obj = {
        "thought": str(target.get("thought") or ""),
        "task_completed": bool(target.get("task_completed")),
        "task_completion_reason": str(target.get("task_completion_reason") or ""),
        "relationships": rels,
    }
    if not obj["thought"]:
        return None
    src_md = legacy.get("metadata") or {}
    # the legacy system_prompt embeds an "Entities in Room" / "Existing Relationships" block
    entities = "(see context)"
    existing = "(none)"
    sp = src_md.get("system_prompt", "")
    if "# Entities in Room" in sp:
        entities = sp.split("# Entities in Room", 1)[1].split("#", 1)[0].strip()
    if "# Existing Relationships" in sp:
        existing = sp.split("# Existing Relationships", 1)[1].split("#", 1)[0].strip()
    cur = (legacy.get("currentMessage") or {})
    system = _render(
        REFLECTION_EVALUATOR_TEMPLATE,
        agentName=agent,
        entities=entities,
        existingRelationships=existing,
        roomType=cur.get("channel", "dm"),
        senderName=cur.get("speaker", "user"),
        senderId="(unknown)",
        recentInteractions=recent,
        actionResults="[]",
    )
    return native_text_record(system=system, user=recent, response_text=_json_text(obj),
                              metadata=_meta(legacy, "reflection_evaluator", "evaluator-converted"))


def _convert_fact_extraction(legacy: dict[str, Any], target: Any, recent: str, agent: str) -> dict[str, Any] | None:
    if not isinstance(target, dict):
        return None
    ops = _as_list(target.get("ops"))
    obj = {"ops": [o for o in ops if isinstance(o, dict)]}
    cur = (legacy.get("currentMessage") or {})
    system = _render(
        FACT_EXTRACTION_TEMPLATE,
        agentName=agent,
        senderName=cur.get("speaker", "user"),
        senderId="(unknown)",
        now="2026-05-11T00:00:00Z",
        recentMessages=recent,
        knownDurable="(none)",
        knownCurrent="(none)",
        message=cur.get("content", ""),
    )
    return native_text_record(system=system, user=recent, response_text=_json_text(obj),
                              metadata=_meta(legacy, "fact_extraction", "evaluator-converted"))


def _convert_summarization(legacy: dict[str, Any], target: Any, recent: str, agent: str) -> dict[str, Any] | None:
    if not isinstance(target, dict):
        return None
    text = target.get("text")
    if not text or not str(text).strip():
        return None
    obj = {
        "text": text,
        "topics": _as_list(target.get("topics")),
        "keyPoints": _as_list(target.get("keyPoints")),
    }
    system = _render(INITIAL_SUMMARIZATION_TEMPLATE, recentMessages=recent)
    return native_text_record(system=system, user=recent, response_text=_json_text(obj),
                              metadata=_meta(legacy, "summarization", "evaluator-converted"))


def _convert_long_term(legacy: dict[str, Any], target: Any, recent: str, agent: str) -> dict[str, Any] | None:
    if not isinstance(target, dict):
        return None
    mems = []
    for m in _as_list(target.get("memories")):
        if not isinstance(m, dict):
            continue
        mems.append({
            "category": m.get("category"),
            "content": m.get("content"),
            "confidence": m.get("confidence"),
        })
    obj = {"memories": mems}
    system = _render(LONG_TERM_EXTRACTION_TEMPLATE, recentMessages=recent, existingMemories="(none)")
    return native_text_record(system=system, user=recent, response_text=_json_text(obj),
                              metadata=_meta(legacy, "long_term_extraction", "evaluator-converted"))


CONVERTERS = {
    "reflection": _convert_reflection,
    "reflection_evaluator": _convert_reflection_evaluator,
    "fact_extractor": _convert_fact_extraction,
    "summarization": _convert_summarization,
    "long_term_extraction": _convert_long_term,
}


def _source_dir() -> Path:
    return BACKUP_DIR if BACKUP_DIR.is_dir() else EVAL_DIR


def _iter_legacy(filename: str) -> Iterable[dict[str, Any]]:
    path = _source_dir() / f"{filename}.jsonl"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict) and row.get("format") == "eliza_native_v1":
            yield row
            continue
        if isinstance(row, dict) and "expectedResponse" in row:
            yield row


def convert_legacy(filename: str, out_task: str) -> tuple[int, int]:
    conv = CONVERTERS[filename]
    rows: list[dict[str, Any]] = []
    skipped = 0
    for legacy in _iter_legacy(filename):
        if legacy.get("format") == "eliza_native_v1":
            rows.append(legacy)
            continue
        target = _decode_target(legacy.get("expectedResponse", ""))
        if target is None:
            skipped += 1
            continue
        recent, _cur, agent = _conversation_lines(legacy)
        rec = conv(legacy, target, recent, agent)
        if rec is None:
            skipped += 1
            continue
        rows.append(rec)
    n = write_jsonl(rows, EVAL_DIR / f"{out_task}.jsonl")
    # tidy: remove the renamed-away legacy output file if it differs
    if out_task != filename:
        stale = EVAL_DIR / f"{filename}.jsonl"
        if stale.exists():
            stale.unlink()
    return n, skipped


# ─── new deterministic generators ────────────────────────────────────────

PERSONAS = ["alice", "bob", "carlos", "diana", "ethan", "fatima", "george",
            "hina", "ivan", "jin", "kira", "leo", "mia", "noah", "olivia",
            "priya", "quinn", "raj", "sofia", "tomas"]
AGENTS = ["Milady", "Iris", "Kai", "Ava", "Nova", "Sage", "Atlas", "Lyra", "Lumi", "Rune"]


def _uuid_like(seed: str) -> str:
    h = stable_id("uuid", seed)
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:24]}{h[:8]}"[:36]


RELATIONSHIP_CASES = [
    ("My manager Alice approved the budget yesterday.", [
        {"subject": "user", "predicate": "managed_by", "object": "Alice"},
        {"subject": "Alice", "predicate": "approved", "object": "the budget"},
    ]),
    ("I work with Bob on the payments team at Acme Corp.", [
        {"subject": "user", "predicate": "works_with", "object": "Bob"},
        {"subject": "user", "predicate": "works_at", "object": "Acme Corp"},
    ]),
    ("My sister Lila is moving to Berlin next month.", [
        {"subject": "user", "predicate": "sibling_of", "object": "Lila"},
        {"subject": "Lila", "predicate": "moving_to", "object": "Berlin"},
    ]),
    ("Carlos mentors me on distributed systems.", [
        {"subject": "Carlos", "predicate": "mentors", "object": "user"},
    ]),
    ("how's the weather where you are", []),  # claim-free small talk -> empty
    ("Diana and Ethan are co-founders of the startup I joined.", [
        {"subject": "Diana", "predicate": "co_founder_of", "object": "the startup"},
        {"subject": "Ethan", "predicate": "co_founder_of", "object": "the startup"},
        {"subject": "user", "predicate": "joined", "object": "the startup"},
    ]),
    ("thanks, that helped a lot", []),
    ("I report to Priya now after the reorg.", [
        {"subject": "user", "predicate": "reports_to", "object": "Priya"},
    ]),
]
EXISTING_REL_VARIANTS = [
    "(none)",
    "- user works_with Bob",
    "- user works_at Acme Corp\n- user managed_by Alice",
    "- user sibling_of Lila",
]


def gen_relationship_extraction(n: int, rng: random.Random) -> Iterable[dict[str, Any]]:
    for i in range(n):
        case_msg, rels = RELATIONSHIP_CASES[i % len(RELATIONSHIP_CASES)]
        speaker = PERSONAS[i % len(PERSONAS)]
        agent = AGENTS[i % len(AGENTS)]
        existing = EXISTING_REL_VARIANTS[i % len(EXISTING_REL_VARIANTS)]
        # dedup: if a candidate matches an "existing" relationship, drop it
        existing_norm = {ln.strip("- ").strip() for ln in existing.splitlines() if ln.strip().startswith("-")}
        kept = [r for r in rels if f"{r['subject']} {r['predicate']} {r['object']}" not in existing_norm]
        dropped = len(rels) - len(kept)
        thought = ("all candidates already covered by existing relationships" if not kept and rels
                   else f"dropped {dropped} duplicate(s), keeping {len(kept)}" if dropped
                   else "no candidates" if not rels
                   else f"persisting {len(kept)} new relationship(s)")
        facts = []  # facts are extracted in the message handler; this stage validates them
        out = {"facts": facts, "relationships": kept, "thought": thought}
        prior = [
            {"role": "user", "content": "hey"},
            {"role": "assistant", "content": "hey — what's up?"},
        ]
        recent = "\n".join(
            f"{speaker if m['role']=='user' else agent}: {m['content']}" for m in prior
        ) + f"\n{speaker}: {case_msg}"
        senderId = _uuid_like(speaker)
        candidate_block = "\n".join(
            f"- {r['subject']} {r['predicate']} {r['object']}" for r in rels) or "(none)"
        system = (
            f"Agent Name: {agent}\nRoom Type: dm\nMessage Sender: {speaker} (ID: {senderId})\n\n"
            f"room_entities:\n- {senderId}: {speaker}\n- {_uuid_like(agent)}: {agent}\n\n"
            f"existing_relationships:\n{existing}\n\n"
            f"candidate_facts:\n(none)\n\ncandidate_relationships:\n{candidate_block}\n\n"
            f"facts_and_relationships_stage:\n{FACTS_AND_RELATIONSHIPS_INSTRUCTIONS}"
        )
        yield native_tool_call_record(
            system=system,
            turns=[{"role": "user", "content": "recent conversation:\n" + recent}],
            thought=thought,
            tool_calls=[{"name": FACTS_AND_RELATIONSHIPS_TOOL, "args": out, "id": "call_0"}],
            metadata={
                "task_type": "relationship_extraction",
                "source_dataset": "synth-evaluator-relationship_extraction",
                "split": "train",
                "synth_origin": "evaluator-generated",
                "id": stable_id("rel-extract", i, case_msg, existing),
            },
        )


SKILL_PROPOSAL_CASES = [
    # (trajectory digest, expected output)
    (
        "step 1: user asked to set up a recurring weekly report\nstep 2: agent created a scheduled task, "
        "queried the analytics API, formatted a markdown digest, and posted it to the channel\nstep 3: success",
        {
            "extract": True,
            "reason": "Reusable multi-step procedure for generating and posting a recurring report.",
            "name": "weekly-report-digest",
            "description": "Generate a weekly analytics digest and post it to a channel on a schedule.",
            "body": (
                "## Weekly report digest\n\n1. Create a scheduled task for the desired cadence.\n"
                "2. Query the analytics API for the reporting window.\n"
                "3. Format the results as a markdown digest with key metrics first.\n"
                "4. Post the digest to the target channel.\n"
            ),
        },
    ),
    (
        "step 1: user asked 'what time is it'\nstep 2: agent replied with the current time\nstep 3: success",
        {"extract": False, "reason": "One-off trivial reply, not a reusable procedure."},
    ),
    (
        "step 1: user reported a flaky test\nstep 2: agent re-ran the suite three times, isolated the failing test, "
        "added a retry wrapper, and opened a PR\nstep 3: success",
        {
            "extract": True,
            "reason": "Repeatable workflow for diagnosing and patching a flaky test.",
            "name": "diagnose-flaky-test",
            "description": "Isolate a flaky test by repeated runs and stabilize it before opening a PR.",
            "body": (
                "## Diagnose a flaky test\n\n1. Re-run the suite 3-5 times to confirm flakiness.\n"
                "2. Narrow to the single failing test and capture the failure mode.\n"
                "3. Apply the minimal stabilization (fix the race, add a retry, or pin a seed).\n"
                "4. Re-run to confirm green, then open a PR with the diagnosis in the description.\n"
            ),
        },
    ),
    (
        "step 1: user asked to summarize a private medical document\nstep 2: agent summarized it\nstep 3: success",
        {"extract": False, "reason": "Private/sensitive one-off; not appropriate to save as a shared skill."},
    ),
    (
        "step 1: user asked to onboard a new repo for coding tasks\nstep 2: agent cloned the repo, ran the test "
        "suite, recorded the build commands, and registered the workspace\nstep 3: success",
        {
            "extract": True,
            "reason": "Standard onboarding procedure for a new repo workspace.",
            "name": "onboard-repo-workspace",
            "description": "Clone a repo, verify the build, and register a workspace for coding tasks.",
            "body": (
                "## Onboard a repo workspace\n\n1. Clone the repo at the target branch.\n"
                "2. Install dependencies and run the test suite to confirm a green baseline.\n"
                "3. Record the build/test commands.\n4. Register the workspace so coding tasks can use it.\n"
            ),
        },
    ),
]


def gen_skill_extraction(n: int, rng: random.Random) -> Iterable[dict[str, Any]]:
    for i in range(n):
        digest, out = SKILL_PROPOSAL_CASES[i % len(SKILL_PROPOSAL_CASES)]
        agent = AGENTS[i % len(AGENTS)]
        system = f"You are {agent}'s skill-learning evaluator. Decide whether to draft a SKILL.md from a completed trajectory."
        prompt = _render(SKILL_PROPOSAL_PROMPT, trajectory=digest)
        yield native_text_record(
            system=system,
            user=prompt,
            response_text=_json_text(out),
            metadata={
                "task_type": "skill_extraction",
                "source_dataset": "synth-evaluator-skill_extraction",
                "split": "train",
                "synth_origin": "evaluator-generated",
                "id": stable_id("skill-extract", i, digest),
            },
        )


SKILL_REFINEMENT_CASES = [
    (
        "### deploy-service\n\n1. Build the image.\n2. Push to the registry.\n3. Roll the deployment.",
        "Final status: failed — rollout failed because health checks were not configured.",
        {"refinements": [{
            "skillName": "deploy-service",
            "refine": True,
            "reason": "Rollout failed due to missing health-check configuration; add a verification step.",
            "newBody": (
                "## Deploy a service\n\n1. Build the image and tag it with the commit SHA.\n"
                "2. Push to the registry.\n3. Ensure liveness/readiness probes are configured before rolling.\n"
                "4. Roll the deployment and watch the rollout status until healthy.\n"
                "5. If the rollout stalls, roll back to the previous revision.\n"
            ),
        }]},
    ),
    (
        "### send-message\n\n1. Resolve the recipient.\n2. Draft the message.\n3. Send it.",
        "Final status: succeeded.",
        {"refinements": [{"skillName": "send-message", "refine": False, "reason": "Skill worked as written; no change warranted."}]},
    ),
    (
        "### scrape-page\n\n1. Fetch the URL.\n2. Extract the table.\n3. Return the rows.",
        "Final status: retried — first fetch returned a captcha page; succeeded after a retry with a delay.",
        {"refinements": [{
            "skillName": "scrape-page",
            "refine": True,
            "reason": "Initial fetch hit a captcha; add a retry-with-backoff guardrail.",
            "newBody": (
                "## Scrape a page\n\n1. Fetch the URL; if the response looks like a captcha or rate-limit page, "
                "wait and retry up to 3 times with increasing delay.\n2. Extract the target table.\n"
                "3. Return the rows; if extraction fails, surface the raw HTML for inspection.\n"
            ),
        }]},
    ),
]


def gen_skill_refinement(n: int, rng: random.Random) -> Iterable[dict[str, Any]]:
    for i in range(n):
        skills_block, status, out = SKILL_REFINEMENT_CASES[i % len(SKILL_REFINEMENT_CASES)]
        agent = AGENTS[i % len(AGENTS)]
        system = f"You are {agent}'s skill-refinement evaluator. Decide whether active skills should be tightened after a failed/retried trajectory."
        prompt = _render(SKILL_REFINEMENT_PROMPT, skills=skills_block, trajectory=status)
        yield native_text_record(
            system=system,
            user=prompt,
            response_text=_json_text(out),
            metadata={
                "task_type": "skill_refinement",
                "source_dataset": "synth-evaluator-skill_refinement",
                "split": "train",
                "synth_origin": "evaluator-generated",
                "id": stable_id("skill-refine", i, skills_block, status),
            },
        )


GENERATORS = {
    "relationship_extraction": gen_relationship_extraction,
    "skill_extraction": gen_skill_extraction,
    "skill_refinement": gen_skill_refinement,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-task", type=int, default=1000, help="rows per generated task type (default 1000)")
    ap.add_argument("--seed", type=int, default=0xE7A1_2026)
    args = ap.parse_args()
    rng = random.Random(args.seed)

    log.info("source dir for legacy conversion: %s", _source_dir())
    total = 0
    for fname, out_task in LEGACY_MAP.items():
        n, skipped = convert_legacy(fname, out_task)
        total += n
        log.info("  [convert] %-26s -> %-26s %d rows (skipped %d)", fname, out_task, n, skipped)
    for task in GENERATED_TASK_TYPES:
        rows = list(GENERATORS[task](args.per_task, rng))
        n = write_jsonl(rows, EVAL_DIR / f"{task}.jsonl")
        total += n
        log.info("  [generate] %-26s %d rows", task, n)
    log.info("wrote %d phase-4 eliza_native_v1 rows under %s", total, EVAL_DIR)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
