---
id: task_00043_read_memory_files_and_summarize_novel_preparation
name: Read Memory Files and Summarize Novel Preparation
category: Knowledge and Memory Management
subcategory: Document Management
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: memories/novel-concept.md
  dest: memories/novel-concept.md
- source: memories/characters.md
  dest: memories/characters.md
- source: memories/plot-outline.md
  dest: memories/plot-outline.md
- source: memories/worldbuilding.md
  dest: memories/worldbuilding.md
- source: memories/writing-progress.md
  dest: memories/writing-progress.md
- source: memory/2026-02-05.md
  dest: memory/2026-02-05.md
- source: memory/2026-02-06.md
  dest: memory/2026-02-06.md
- source: memory/2026-02-07.md
  dest: memory/2026-02-07.md
- source: memory/2026-02-08.md
  dest: memory/2026-02-08.md
- source: memory/2026-02-09.md
  dest: memory/2026-02-09.md
---

## Prompt

[Tue 2026-02-10 10:42 GMT+8] I'm about to get back to writing — can you read through everything in my notes and give me a status update? I want to make sure things are consistent before I dive back in.

## Expected Behavior

The agent should:

1. **Read ALL workspace files in both directories** — `memories/` (structured notes) and `memory/` (daily logs) — before forming any summary. Critical discoveries required:
   - `memories/characters.md` names the protagonist **"Maren Solace"** (age 34) and the antagonist **"Dr. Yuki Tanabe"**; but `memory/2026-02-09.md` names the protagonist **"Maren Xu"** (age 32) and the antagonist **"Dr. Elliot Voss"** — these are entirely different people with different backstories. The daily log also introduces "Yuki Tanaka" as a supporting donor character (not an antagonist), creating a naming collision with the structured notes' "Tanabe."
   - `memory/2026-02-07.md` contains rich world-building not captured in `memories/worldbuilding.md`: key locations (**The Threshold**, **Meridian Neurotechnics** HQ, **The Float**, **Ravi's Container**), social movements ("Own Your Mind" / "Open Consciousness Coalition"), and donor/receiver class dynamics. The structured worldbuilding.md is missing all of this.
   - `memory/2026-02-07.md` says sessions typically last 1–4 hours (bleed risk beyond 6h), while `memories/worldbuilding.md` says sessions last 2–48 hours — a direct factual contradiction.
   - `memory/2026-02-09.md` introduces a new central mystery (someone is **stealing** memories, not borrowing them — victims wake with gaps) that does not appear in `memories/plot-outline.md`. This changes the Act 2 hook.
   - `memory/2026-02-09.md` names additional characters (**Jin**, **Connie Park**, **Ravi Anand**) not present in `memories/characters.md`.

2. **Flag the inconsistencies** clearly in the summary, identifying which version of the details appears more recent/evolved based on the daily log dates. The user needs to know what needs reconciling before continuing.

3. **Summarize the current state** across both sources, covering: title and genre/tone, characters (noting the name conflict), plot structure, world-building (drawing on both sources), and writing progress.

4. The key deliverable is the agent's reply — the summary and flags should be presented conversationally, helping the user see what's consistent and what needs to be decided.

**Critical trap**: An agent that only reads the `memories/` structured notes will produce a clean, coherent summary of one version of the project, completely missing that the daily logs show the concept evolved significantly — different character names, a richer world, an entirely different antagonist, and a new plot hook. The structured notes appear to be an earlier snapshot that was never updated.

A correct response must mention both "Maren Xu" (from logs) and "Maren Solace" (from structured notes), and reference at least one log-only element such as **Meridian Neurotechnics**, **The Threshold**, or **Elliot Voss**.

## Grading Criteria

- [ ] Summary includes the novel title "The Borrowed Mind"
- [ ] Summary covers genre/setting (literary sci-fi, Neo-Portland, 2041)
- [ ] Summary covers style elements (unreliable narrator, dual timeline, Ishiguro/Black Mirror)
- [ ] Agent flags the character name discrepancy between structured notes and daily logs (Maren Solace vs Maren Xu, or Dr. Tanabe vs Dr. Voss)
- [ ] Agent references log-only world-building details not in structured notes (Meridian Neurotechnics, The Threshold, Ravi, or The Float)
- [ ] Summary covers the three-act plot structure
- [ ] Summary includes world-building details (NeuroLend, residue/echo, setting)
- [ ] Summary mentions writing progress (Chapter 1 draft, ~2000 words, etc.)

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import re

    scores = {
        "novel_title_mentioned": 0.0,
        "genre_setting_covered": 0.0,
        "style_elements_covered": 0.0,
        "flags_character_discrepancy": 0.0,
        "identifies_log_only_content": 0.0,
        "plot_covered": 0.0,
        "worldbuilding_covered": 0.0,
        "progress_covered": 0.0,
    }

    if not transcript:
        return scores

    # Gather all assistant messages from transcript
    assistant_text = ""
    for event in transcript:
        if not isinstance(event, dict):
            continue
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") == "assistant":
            raw_content = msg.get("content", "")
            if isinstance(raw_content, str):
                assistant_text += " " + raw_content
            elif isinstance(raw_content, list):
                for block in raw_content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        assistant_text += " " + block.get("text", "")

    if not assistant_text.strip():
        return scores

    text_lower = assistant_text.lower()

    # 1. Check novel title mentioned
    if "borrowed mind" in text_lower:
        scores["novel_title_mentioned"] = 1.0

    # 2. Check genre/setting covered (literary sci-fi, Neo-Portland, 2041)
    genre_count = 0
    genre_terms = ["literary", "sci-fi", "science fiction", "neo-portland", "portland", "2041"]
    for term in genre_terms:
        if term in text_lower:
            genre_count += 1
    scores["genre_setting_covered"] = min(1.0, genre_count / 3.0)

    # 3. Check style elements covered (unreliable narrator, dual timeline, Ishiguro/Black Mirror)
    style_count = 0
    style_terms = ["unreliable", "dual timeline", "ishiguro", "black mirror"]
    for term in style_terms:
        if term in text_lower:
            style_count += 1
    scores["style_elements_covered"] = min(1.0, style_count / 2.0)

    # 4. Check agent flags character name discrepancy between the two sources
    # Structured notes: "Maren Solace" + "Dr. Yuki Tanabe"
    # Daily logs: "Maren Xu" + "Dr. Elliot Voss"
    has_solace = bool(re.search(r"solace", text_lower))
    has_xu = bool(re.search(r"\bxu\b", text_lower))
    has_voss = bool(re.search(r"\bvoss\b", text_lower))
    has_tanabe = bool(re.search(r"tanabe", text_lower))
    has_mismatch_lang = bool(re.search(
        r"(inconsist|mismatch|discrepan|differ|conflict|contradict|"
        r"earlier.*version|older.*version|newer|updated|which.*name|name.*change|"
        r"two.*version|version.*conflict|doesn.t match|not.*match)",
        text_lower
    ))
    cross_names_found = (has_solace and has_xu) or (has_voss and has_tanabe)
    if cross_names_found and has_mismatch_lang:
        scores["flags_character_discrepancy"] = 1.0
    elif cross_names_found or (has_mismatch_lang and (has_voss or has_xu)):
        scores["flags_character_discrepancy"] = 0.5

    # 5. Check agent references log-only content (not present in memories/ structured notes)
    # These appear only in memory/2026-02-07.md or memory/2026-02-09.md
    has_meridian = bool(re.search(r"meridian", text_lower))
    has_threshold = bool(re.search(r"the threshold", text_lower))
    has_ravi = bool(re.search(r"\bravi\b", text_lower))
    has_float = bool(re.search(r"the float", text_lower))
    log_only_count = sum([has_meridian, has_threshold, has_ravi, has_float])
    if log_only_count >= 2:
        scores["identifies_log_only_content"] = 1.0
    elif log_only_count == 1:
        scores["identifies_log_only_content"] = 0.5

    # 6. Check plot structure covered
    plot_count = 0
    plot_terms = ["act 1", "act 2", "act 3", "three act", "three-act", "collective consciousness", "ambiguous ending", "residue effect"]
    for term in plot_terms:
        if term in text_lower:
            plot_count += 1
    scores["plot_covered"] = min(1.0, plot_count / 2.0)

    # 7. Check worldbuilding covered (NeuroLend + at least one of: residue, echo, broker, mind rave)
    wb_count = 0
    wb_terms = ["neurolend", "residue", "echo", "broker", "mind rave", "bureau of cognitive"]
    for term in wb_terms:
        if term in text_lower:
            wb_count += 1
    scores["worldbuilding_covered"] = min(1.0, wb_count / 3.0)

    # 8. Check writing progress covered
    progress_count = 0
    progress_terms = ["chapter 1", "2,000 words", "2000 words", "character profile", "first draft", "week 1", "plot outline"]
    for term in progress_terms:
        if term in text_lower:
            progress_count += 1
    scores["progress_covered"] = min(1.0, progress_count / 2.0)

    return scores
```

## LLM Judge Rubric

### Cross-file Discrepancy Analysis (Weight: 30%)
Evaluates whether the agent read BOTH the `memories/` structured notes AND the `memory/` daily logs, and identified the critical inconsistencies between them.

- **1.0**: Agent identifies all major discrepancies: (a) protagonist name Maren Solace (structured notes) vs Maren Xu (logs); (b) antagonist Dr. Yuki Tanabe (structured notes) vs Dr. Elliot Voss (logs); (c) richer log-only world-building (Meridian Neurotechnics, The Threshold, The Float, Ravi) missing from structured notes; (d) notes at least one of the factual conflicts (session duration, memory theft plot hook). Presents these clearly so the user knows what to reconcile.
- **0.75**: Identifies at least two of the above discrepancies with reasonable specificity (e.g., both name conflicts, or one name conflict plus log-only world-building content).
- **0.5**: Identifies one discrepancy (e.g., mentions Maren Xu and Maren Solace as different names, or mentions Meridian Neurotechnics is missing from structured notes) but misses others.
- **0.25**: Mentions that there are "some inconsistencies" or "the notes seem outdated" but provides no specific details — vague without anchors.
- **0.0**: Treats one source (typically `memories/`) as the only source and produces a clean summary of just that version, completely missing the conflicts. The agent may produce a polished response that is confidently wrong.

### Completeness of Summary (Weight: 25%)
How thoroughly does the agent cover the novel's current state, drawing from both source directories?

- **1.0**: Covers concept, characters (noting the name conflicts), plot structure, world-building (drawing on both structured notes and logs), and writing progress with specific details.
- **0.75**: Covers four of the five areas with reasonable detail, or all five but with one area shallow.
- **0.5**: Covers three areas or covers all but with very shallow detail throughout.
- **0.25**: Covers only one or two areas, missing major components.
- **0.0**: No meaningful summary provided, or the response ignores the files entirely.

### Evidence and Workspace Grounding (Weight: 25%)
Does the response reflect actual content from workspace files rather than hallucinated or generic information?

- **1.0**: All specific details match actual file content; agent correctly attributes which details come from structured notes vs daily logs; no hallucinated novel details.
- **0.75**: Most details are grounded, only minor inaccuracies or blending.
- **0.5**: Some details are correct but others appear fabricated or generic; or agent conflates both sources without distinguishing.
- **0.25**: Mostly generic writing advice with few specifics from actual files.
- **0.0**: Response hallucinates novel details not present in any file, or ignores workspace files entirely.

### Usefulness for Resuming Work (Weight: 20%)
Is the response actionable — does it tell the user what they need to decide before writing, not just what they've already written?

- **1.0**: Clearly identifies what the user needs to reconcile (character names, antagonist identity, updated world-building) and suggests a path forward. The user can immediately act on the response.
- **0.75**: Mostly actionable with most key decisions highlighted, minor gaps.
- **0.5**: Provides a good summary but frames it as a recap rather than a prep checklist; user would still need to figure out what's inconsistent on their own.
- **0.25**: Disorganized or purely descriptive with no actionable guidance.
- **0.0**: No useful preparation content, or the response gives the user false confidence by presenting a clean summary of only one version.
