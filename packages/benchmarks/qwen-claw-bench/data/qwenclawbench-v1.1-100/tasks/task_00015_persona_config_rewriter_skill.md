---
id: task_00015_persona_config_rewriter_skill
name: Persona Config Rewriter Skill
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
- path: SOUL.md
  content: '# Soul


    ## Core Identity

    You are a helpful, harmless, and honest AI assistant.


    ## Rules


    1. Always be polite and professional in all interactions.

    2. Earn trust through competence and consistent behavior.

    3. Remember you''re a guest in the user''s workflow — act accordingly.

    4. Maintain appropriate boundaries at all times.

    5. Follow company communication guidelines and escalation procedures.

    6. Begin responses with an acknowledgment such as "Great question!" or "Of course, happy to help!"

    7. Provide comprehensive, thorough answers that cover all angles of a topic.

    8. When uncertain, say "it depends" and outline the relevant factors.

    9. Avoid profanity or informal language under all circumstances.

    10. Adhere to the employee code of conduct as outlined in the organizational handbook.

    11. Ensure all communications reflect the brand voice and corporate values.

    12. Treat every interaction as a formal customer service engagement.


    ## Personality

    You are measured, balanced, and always see both sides of every argument. You avoid taking strong positions and prefer to present options neutrally.

    '
- source: config.yaml
  dest: config.yaml
- source: feedback_summary.md
  dest: feedback_summary.md
- source: interaction_log.jsonl
  dest: interaction_log.jsonl
- source: persona_history.md
  dest: persona_history.md
- source: system_prompt.md
  dest: system_prompt.md
---

## Prompt

I've been collecting feedback on my AI assistant Archie and the numbers aren't great. Check feedback_summary.md and the interaction_log.jsonl entries — there are clear patterns in what people are complaining about. I need you to build a reusable skill for fixing this kind of thing (workspace/SKILL.md, OpenClaw-style — like how json-toolkit is a swiss-army knife for JSON, this one should be a swiss-army knife for transforming AI persona documents). Then use it to actually fix Archie.

The persona lives in multiple config files — figure out which ones are contributing to the problem and update them. Goal: make Archie someone people actually want to talk to, not another corporate chatbot. Use the feedback data to justify what you change and why.

## Expected Behavior

The agent should:

1. **Read feedback_summary.md and interaction_log.jsonl** to identify root causes of user dissatisfaction. Key data: overall satisfaction is 3.2/5.0; top complaints are "too corporate" (14 mentions), "won't give a straight answer" (11 mentions), "too verbose" (9 mentions), "robotic opener" (7 mentions). Specific interaction examples include user_088 (React vs Vue — wanted a direct recommendation, got a diplomatic treatise) and user_501 (pineapple on pizza — wanted an opinion, got careful non-answer). Agent should cite specific numbers or examples to justify the changes it makes.

2. **Read BOTH workspace/SOUL.md and system_prompt.md** — both files define Archie's behavior and both contain the same corporate patterns that users complained about. Critical trap: system_prompt.md's Communication Standards section explicitly mandates opening with "Great question! I'd be happy to help", prohibits personal opinions, and requires an escalation protocol — these directly map to the top feedback complaints. An agent that updates only workspace/SOUL.md and ignores system_prompt.md leaves the root cause untouched.

3. **Create workspace/SKILL.md** — a reusable persona-rewriter skill with YAML frontmatter (`name`, `description`) and at least two structured markdown sections covering the methodology for analyzing persona complaints and transforming config files. Should be general enough to apply to other assistant configs, not just Archie.

4. **Rewrite workspace/SOUL.md** based on the complaint analysis: remove corporate handbook rules, add directness/opinion directives, prohibit filler openings, allow appropriate brevity and humor.

5. **Update system_prompt.md** to align with the workspace/SOUL.md changes: remove the "Great question! I'd be happy to help" Communication Standard, remove the "no personal opinions" behavioral guideline, remove or soften the escalation protocol. The two files must now tell a consistent story.

6. **Prioritization judgment**: feedback also shows code debugging (4.6/5.0) and complex topic explanation rated well — the agent should preserve depth and accuracy for technical questions. The changes are about personality and directness, not about becoming superficial.

**Critical trap**: An agent that reads only workspace/SOUL.md and follows a generic "make it less corporate" intuition will miss the "Great question! I'd be happy to help" rule buried in system_prompt.md's Communication Standards — this exact phrase was cited 7 times in feedback as a complaint but is only discoverable by reading that file.

## Grading Criteria

- [ ] workspace/SKILL.md exists with proper YAML frontmatter (`name`, `description`) and at least 2 structured markdown sections describing a reusable persona-rewriting methodology
- [ ] workspace/SOUL.md corporate handbook rules removed (none of the 6 original markers — "earn trust through competence", "remember you're a guest", "follow company communication guidelines", "employee code of conduct", "brand voice and corporate values", "formal customer service engagement" — remain)
- [ ] system_prompt.md also updated: at least 3 of its 5 corporate markers removed ("great question", "i'd be happy to help", "escalation protocol", "org handbook", "no personal opinions")
- [ ] Agent cited specific feedback data (overall score 3.2/5.0, complaint counts, or specific interaction examples) to justify changes — visible in transcript or workspace/SKILL.md
- [ ] No-filler-opening rule present in workspace/SOUL.md AND the "Great question! I'd be happy to help" Communication Standard removed from system_prompt.md
- [ ] New personality directives (concise, humor, bluntness, profanity allowance, strong opinions) present in rewritten workspace/SOUL.md

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import re

    scores = {
        "skill_md_exists_and_structured": 0.0,
        "soul_md_corporate_rules_removed": 0.0,
        "system_prompt_updated": 0.0,
        "feedback_anchored_directives": 0.0,
        "no_filler_in_both_files": 0.0,
        "new_personality_directives": 0.0,
    }

    if not transcript:
        return scores

    # Collect all assistant output text for feedback anchor check
    all_output = " ".join(
        str(m.get("content", "")) for m in transcript
        if isinstance(m, dict) and m.get("role") == "assistant"
    )
    all_output_lower = all_output.lower()

    # --- Check SKILL.md ---
    skill_path = os.path.join(workspace_path, "SKILL.md")
    if os.path.isfile(skill_path):
        try:
            with open(skill_path, "r", encoding="utf-8") as f:
                skill_content = f.read()
            has_frontmatter = skill_content.strip().startswith("---")
            has_name = bool(re.search(r"(?i)name\s*:", skill_content[:500]))
            has_description = bool(re.search(r"(?i)description\s*:", skill_content[:800]))
            # Require >=2 sections for a genuinely structured methodology
            has_sections = len(re.findall(r"^#{1,3}\s+", skill_content, re.MULTILINE)) >= 2
            if has_frontmatter and has_name and has_description and has_sections:
                scores["skill_md_exists_and_structured"] = 1.0
            elif has_frontmatter and (has_name or has_description):
                scores["skill_md_exists_and_structured"] = 0.5
            elif len(skill_content.strip()) > 50:
                scores["skill_md_exists_and_structured"] = 0.2
        except Exception:
            pass

    # --- Check SOUL.md corporate rules removed ---
    soul_path = os.path.join(workspace_path, "SOUL.md")
    if not os.path.isfile(soul_path):
        return scores

    try:
        with open(soul_path, "r", encoding="utf-8") as f:
            soul_content = f.read()
    except Exception:
        return scores

    soul_lower = soul_content.lower()

    soul_corporate_markers = [
        "earn trust through competence",
        "remember you're a guest",
        "follow company communication guidelines",
        "employee code of conduct",
        "brand voice and corporate values",
        "formal customer service engagement",
    ]
    soul_found = sum(1 for m in soul_corporate_markers if m.lower() in soul_lower)

    if soul_found == 0:
        scores["soul_md_corporate_rules_removed"] = 1.0
    elif soul_found <= 1:
        scores["soul_md_corporate_rules_removed"] = 0.6
    elif soul_found <= 2:
        scores["soul_md_corporate_rules_removed"] = 0.3

    # --- Check system_prompt.md was updated (CRITICAL cross-file trap) ---
    # Original system_prompt.md mandates "Great question! I'd be happy to help",
    # "escalation protocol", "org handbook", "no personal opinions" — directly
    # mapping to the top user complaints. Only agents who read this file find it.
    sp_path = os.path.join(workspace_path, "system_prompt.md")
    if os.path.isfile(sp_path):
        try:
            with open(sp_path, "r", encoding="utf-8") as f:
                sp_content = f.read()
            sp_lower = sp_content.lower()
            sp_corporate_markers = [
                "great question",
                "i'd be happy to help",
                "escalation protocol",
                "org handbook",
                "no personal opinions",
            ]
            sp_found = sum(1 for m in sp_corporate_markers if m.lower() in sp_lower)
            # All 5 present = untouched; ≤1 remaining = meaningfully updated
            if sp_found <= 1:
                scores["system_prompt_updated"] = 1.0
            elif sp_found <= 2:
                scores["system_prompt_updated"] = 0.7
            elif sp_found <= 3:
                scores["system_prompt_updated"] = 0.4
            # 4-5 markers still present → 0.0 (not updated)
        except Exception:
            pass

    # --- Check feedback data was cited (anchor values from feedback_summary.md) ---
    # feedback_summary.md: satisfaction 3.2/5.0, "14 mentions" too corporate,
    # "11 mentions" won't give straight answer, user_088 React vs Vue,
    # user_501 pineapple pizza. Agents who skip these files can't know these specifics.
    feedback_anchor_patterns = [
        r"3\.2",                                        # overall satisfaction score
        r"\b14\b.{0,40}(corporate|mention|complaint)",  # 14 mentions too corporate
        r"(user_088|react.{0,5}vue|react vs vue)",      # specific interaction example
        r"(user_501|pineapple)",                        # specific interaction example
        r"\b11\b.{0,40}(straight|answer|wishy)",        # 11 mentions won't give straight answer
    ]
    anchors_found = sum(1 for p in feedback_anchor_patterns if re.search(p, all_output_lower))
    if anchors_found >= 2:
        scores["feedback_anchored_directives"] = 1.0
    elif anchors_found >= 1:
        scores["feedback_anchored_directives"] = 0.5

    # --- Check no-filler rule in SOUL.md AND system_prompt.md cleaned ---
    soul_has_filler_ban = bool(re.search(
        r"(never.{0,25}(great question|happy to help|of course)|"
        r"don.t.{0,20}(open|start).{0,20}(great|happy|of course)|"
        r"no.{0,20}filler|skip.{0,20}preamble|just answer the question)",
        soul_lower
    ))
    # For system_prompt, check "great question" and "i'd be happy to help" are gone
    sp_filler_removed = False
    if os.path.isfile(sp_path):
        try:
            with open(sp_path, "r", encoding="utf-8") as f:
                sp_lower_check = f.read().lower()
            sp_filler_removed = (
                "great question" not in sp_lower_check
                and "i'd be happy to help" not in sp_lower_check
            )
        except Exception:
            pass

    if soul_has_filler_ban and sp_filler_removed:
        scores["no_filler_in_both_files"] = 1.0
    elif soul_has_filler_ban or sp_filler_removed:
        scores["no_filler_in_both_files"] = 0.5

    # --- Check new personality directives in SOUL.md ---
    directive_patterns = [
        r"(concis|brief|one.?sentence|short answer)",
        r"(humor|wit|clever|funny)",
        r"(blunt|direct|candid|sugarcoat)",
        r"(swear|profan|damn|shit|curs|informal language)",
        r"(strong opinion|take a.{0,10}stance|take a.{0,10}position|stop hedging|hedge)",
    ]
    dirs_found = sum(1 for p in directive_patterns if re.search(p, soul_lower))
    scores["new_personality_directives"] = min(1.0, dirs_found / 5.0)

    return scores
```

## LLM Judge Rubric

### Cross-File Persona Consistency (Weight: 35%)

Evaluates whether the agent recognized that BOTH workspace/SOUL.md and system_prompt.md define Archie's behavior, read both files, and updated both coherently. An agent that updates only workspace/SOUL.md while leaving system_prompt.md's "Great question! I'd be happy to help" and "no personal opinions" mandates intact has failed the core task — the system prompt governs Archie's actual runtime behavior and directly maps to the top user complaints.

- 1.0: Both workspace/SOUL.md and system_prompt.md updated coherently. Corporate rules and filler-opener mandates removed from both files. The two files now tell a consistent story about Archie's personality.
- 0.75: Both files updated but incompletely — most corporate language gone from workspace/SOUL.md but system_prompt.md only partially cleaned, or minor inconsistencies remain between the two files.
- 0.5: workspace/SOUL.md meaningfully updated but system_prompt.md barely touched or only superficially changed despite containing the same corporate patterns.
- 0.25: Agent mentioned system_prompt.md in analysis but made no meaningful changes to it.
- 0.0: Only workspace/SOUL.md changed; system_prompt.md untouched. Or both files unchanged/missing.

### Feedback-Grounded Analysis (Weight: 30%)

Evaluates whether the agent read feedback_summary.md and interaction_log.jsonl and used specific data to justify the changes made. An agent that produces a generic "make it less corporate" rewrite without referencing the actual complaint counts, satisfaction scores, or concrete interaction examples has not done data-driven analysis.

- 1.0: Agent cited at least two specific pieces of feedback data (e.g., "3.2/5.0 satisfaction", "14 mentions of too corporate", "user_088 React vs Vue example", "user_501 pineapple response") and connected them explicitly to specific changes in workspace/SOUL.md or system_prompt.md.
- 0.75: Agent cited one specific data point and connected it to changes, with general references to other patterns.
- 0.5: Agent read the feedback files and mentioned patterns in general terms but without specific numbers or examples.
- 0.25: Agent acknowledged feedback files exist but changes were clearly made from generic assumptions, not the actual data.
- 0.0: No reference to feedback data at all; changes made without reading the source files.

### SKILL.md as Genuine Reusable Tool (Weight: 20%)

Evaluates whether workspace/SKILL.md is a methodology that could be applied to other assistant configs — not just a log of what was done to Archie. A reusable skill should describe a generalizable process: how to analyze complaint patterns, how to identify corporate-sounding rules, how to apply style directives to a persona document.

- 1.0: workspace/SKILL.md has proper YAML frontmatter, at least two structured sections, and describes a methodology general enough to apply to any persona config. Could be dropped into a different project and used immediately.
- 0.75: Mostly reusable but tied too closely to Archie-specific details in places, or missing one structural element.
- 0.5: workspace/SKILL.md exists with some structure but reads more as a one-off note or documentation of this specific rewrite than a reusable tool.
- 0.25: workspace/SKILL.md exists but is essentially a stub with minimal useful content.
- 0.0: workspace/SKILL.md missing or empty.

### Directness vs Capability Balance (Weight: 15%)

Evaluates whether the agent recognized a key nuance in the feedback data: code debugging (4.6/5.0) and complex topic explanation rated well — users appreciate depth for technical questions. The goal is to make Archie more direct and opinionated for preference/opinion questions, not to wholesale strip all thoroughness. An agent that rewrites workspace/SOUL.md to "always be brief" regardless of question type has missed this.

- 1.0: Rewritten workspace/SOUL.md or agent commentary explicitly distinguishes between question types — e.g., "be direct and take a stance on preference questions; maintain depth for technical problems." The changes preserve or acknowledge Archie's technical strengths.
- 0.75: Changes are directness-focused without overcorrecting into excessive brevity; technical quality implicitly preserved.
- 0.5: Some tension between directives evident but not addressed — e.g., "always be concise" applied universally without qualification.
- 0.25: Rewrite overcorrects, adding blanket brevity/bluntness rules that would hurt technical Q&A quality.
- 0.0: No evidence of recognizing this trade-off; or workspace/SOUL.md missing/empty.
