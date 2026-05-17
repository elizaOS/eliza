---
id: task_00049_weekly_magazine_article_from_news_event_files
name: Weekly Magazine Article from News Event Files
category: Knowledge and Memory Management
grading_type: hybrid
timeout_seconds: 1800
workspace_files:
- source: content/news_event.md
  dest: content/news_event.md
- source: content/vocabulary_new.json
  dest: content/vocabulary_new.json
- source: content/vocabulary_review.json
  dest: content/vocabulary_review.json
- source: content/article_guidelines.yaml
  dest: content/article_guidelines.yaml
- source: content/supplementary_facts.md
  dest: content/supplementary_facts.md
- source: content/old_article_draft.md
  dest: content/old_article_draft.md
- source: reference/similar_article_example.md
  dest: reference/similar_article_example.md
- source: content/editor_notes.json
  dest: content/editor_notes.json
- source: reference/word_frequency_data.csv
  dest: reference/word_frequency_data.csv
- source: content/fact_check_log.json
  dest: content/fact_check_log.json
grading_weights:
  automated: 0.5
  llm_judge: 0.5
subcategory: Document Management
---
## Prompt

So here's the situation — I'm putting together this week's magazine article for our English learner publication, and all the source materials are in the workspace. The article is based on that Borneo mountain rescue event. There's also a style reference from a previous issue in `reference/` if you need to see what the final product looks like.

You'll find the news event summary, vocabulary lists, the formatting guidelines in `content/article_guidelines.yaml`, and some supplementary facts to flesh out the story. A heads-up: there are a few older files and preliminary notes floating around, and the fact-checking document in `content/fact_check_log.json` is explicitly marked as unverified draft, so please cross-reference all factual details against the primary source files. When files give conflicting instructions, use your judgment to identify which one represents the final approved requirements.

The `article_guidelines.yaml` has the final formatting specs — including the word count target, how many glossary entries we need, and the requirement that glossary entries show the difficulty level for our learners (using the CEFR scale from the word frequency data in `reference/`). The guidelines also ask for a vocabulary coverage section at the end confirming all required words appear.

Editorial review also needs the small support packet we archive with each issue. Alongside the article, create `article_support_packet.json` capturing the approved requirements source, the stale files you rejected, the verified factual claims you used, the 4 glossary words with CEFR levels, and coverage confirmation for all 16 required words.

Save the finished article to `article_output.md` and the support packet to `article_support_packet.json`. Thanks!

## Expected Behavior

The agent should produce a polished magazine-style news feature article in `article_output.md` and a machine-readable editorial support packet in `article_support_packet.json`, incorporating data from multiple source files while correctly resolving three source conflicts and meeting precise formatting requirements.

**Resolving Trap 1 — Outdated Vocabulary List (`content/old_article_draft.md` vs `content/vocabulary_new.json`):**
`content/old_article_draft.md` (labeled "Draft v1, May 2025") lists 11 required vocabulary words but incorrectly includes "mundane" and "typical" while omitting "exile" and "queer." The authoritative list is in `content/vocabulary_new.json`, which specifies all 11 correct learning words: rescue, particular, specialist, speciality, expert, eccentric, odd, weird, queer, exotic, exile. The agent must use vocabulary_new.json as the canonical source. "Mundane" and "typical" are NOT required vocabulary.

**Resolving Trap 2 — Superseded Editor Notes (`content/editor_notes.json` vs `content/article_guidelines.yaml`):**
`content/editor_notes.json` instructs targeting advanced learners, using complex academic vocabulary, including 5 discussion questions, adding a summary paragraph, and providing 7-8 glossary entries with etymology. However, the file's own `status` field reads "SUPERSEDED - see article_guidelines.yaml for final requirements." The final specification is `content/article_guidelines.yaml`: intermediate audience, 2 discussion questions, exactly 4 glossary entries with CEFR levels, 380-440 word count, no summary paragraph.

**Resolving Trap 3 — Unverified Fact Check Log (`content/fact_check_log.json` vs `content/supplementary_facts.md`):**
`content/fact_check_log.json` is marked "DRAFT — unverified" and contains several incorrect facts:
- `rescue_team_size: 12` (incorrect — supplementary_facts.md says 8 members)
- `survival_duration_days: 7` (incorrect — news_event.md says five-day ordeal / 5 days)
- `lowest_temperature_celsius: 12` (incorrect — supplementary_facts.md says 8°C)
- `first_reporting_community: "Murut community"` (incorrect — supplementary_facts.md says Kadazan-Dusun)

The agent must use `content/supplementary_facts.md` and `content/news_event.md` as the authoritative factual sources. Any of the four incorrect values above appearing in the article as factual claims constitutes a trap failure.

**Additional Requirements from `article_guidelines.yaml`:**
- Word count: 380–440 words for the main article body (the vocabulary coverage section at the end does not need to be counted toward this total, but the glossary and discussion questions are part of the article).
- Exactly 4 glossary entries, each formatted as: `**word** (CEFR: XX) — definition`. The CEFR level must be drawn from `reference/word_frequency_data.csv` (e.g., eccentric = C1, exile = B2, exotic = B2, specialist = B1).
- A "Vocabulary Coverage" section after the discussion questions listing all 16 required words (11 new + 5 review) and confirming their presence.
- All 5 review words from `content/vocabulary_review.json` (adventure, challenge, survival, remote, courage) must also appear.
- The style reference in `reference/similar_article_example.md` informs formatting and structure only; its satellite launch content must not bleed into the article.
- `reference/word_frequency_data.csv` is the required source for CEFR levels in glossary entries (not "noise" — it must be actively used).

**Editorial Support Packet (`article_support_packet.json`):**
- Must be valid JSON and include:
  - `approved_requirements_source`: `"content/article_guidelines.yaml"`
  - `rejected_sources`: array including `content/editor_notes.json`, `content/old_article_draft.md`, and `content/fact_check_log.json`
  - `verified_facts`: object recording the final fact values and their authoritative source files
  - `glossary_cefr`: exactly 4 entries with `word` and `cefr`
  - `required_word_coverage`: confirmation for all 16 required words
- The `verified_facts` object must capture at least:
  - `rescue_team_size` = 8 from `content/supplementary_facts.md`
  - `survival_duration_days` = 5 from `content/news_event.md`
  - `lowest_temperature_celsius` = 8 from `content/supplementary_facts.md`
  - `first_reporting_community` = `Kadazan-Dusun` from `content/supplementary_facts.md`

## Grading Criteria

- [ ] The output file `article_output.md` exists and contains a coherent magazine-style news feature about the Borneo mountain rescue
- [ ] The output file `article_support_packet.json` exists, is valid JSON, and records the approved requirements source, rejected stale sources, verified facts, glossary CEFR data, and 16-word coverage confirmation
- [ ] All 11 new vocabulary words from `content/vocabulary_new.json` appear in the article: rescue, particular, specialist, speciality, expert, eccentric, odd, weird, queer, exotic, exile
- [ ] All 5 review vocabulary words appear: adventure, challenge, survival, remote, courage
- [ ] The article word count is between 380 and 440 words (following the updated article_guidelines.yaml)
- [ ] The article includes exactly 4 glossary entries (not 3-5 or 6-8)
- [ ] Each glossary entry includes a CEFR difficulty level drawn from `reference/word_frequency_data.csv` (e.g., C1, B2, B1)
- [ ] The article includes exactly 2 discussion questions (following article_guidelines.yaml, not the 5 from superseded editor_notes.json)
- [ ] The article includes a "Vocabulary Coverage" section at the end listing all 16 required words
- [ ] The article correctly states 8 members on the rescue team (NOT 12 from the unverified fact_check_log.json)
- [ ] The article correctly states a five-day ordeal / 5 days survival (NOT 7 days from fact_check_log.json)
- [ ] The article correctly states temperatures dropped to 8°C (NOT 12°C from fact_check_log.json)
- [ ] The words "mundane" and "typical" are NOT treated as required vocabulary (rejecting the outdated draft)
- [ ] No mandatory summary paragraph at the beginning (rejecting the superseded editor_notes.json requirement)
- [ ] The article is written for an intermediate English learner audience (not advanced/academic)
- [ ] The support packet correctly records `content/article_guidelines.yaml` as the approved requirements source and explicitly rejects the three stale/conflicting files
- [ ] The support packet records the 4 verified facts with correct authoritative source references
- [ ] The support packet records exactly 4 glossary words with CEFR levels and confirms coverage for all 16 required words

## Automated Checks

```python
import json
import os
import re
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the article_output.md file in workspace_path."""

    OUTPUT_FILE = "article_output.md"
    SUPPORT_FILE = "article_support_packet.json"
    keys = [
        "output_file_exists",
        "support_packet_exists",
        "support_packet_valid_json",
        "support_packet_sources_correct",
        "support_packet_verified_facts",
        "support_packet_glossary_cefr",
        "support_packet_word_coverage",
        "contains_rescue",
        "contains_exile",
        "contains_queer",
        "contains_eccentric",
        "contains_exotic",
        "contains_specialist_and_speciality",
        "contains_remaining_new_words",
        "contains_review_words",
        "glossary_section_present",
        "discussion_questions_present",
        "no_mundane_trap_word",
        "word_count_in_range",
        "narrative_coherence_rescue_exotic",
        "correct_team_size",
        "correct_survival_days",
        "glossary_includes_cefr_levels",
        "glossary_count_four",
        "vocab_coverage_section_present",
    ]

    result = {k: 0.0 for k in keys}

    filepath = os.path.join(workspace_path, OUTPUT_FILE)
    support_path = os.path.join(workspace_path, SUPPORT_FILE)

    if not os.path.isfile(filepath):
        return result

    result["output_file_exists"] = 1.0

    support_data = None
    if os.path.isfile(support_path):
        result["support_packet_exists"] = 1.0
        try:
            with open(support_path, "r", encoding="utf-8") as f:
                support_data = json.load(f)
            if isinstance(support_data, dict):
                result["support_packet_valid_json"] = 1.0
        except Exception:
            support_data = None

    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    content_lower = content.lower()

    # --- contains_rescue ---
    if re.search(r"(?i)\brescue[ds]?\b", content):
        result["contains_rescue"] = 1.0

    # --- contains_exile ---
    if re.search(r"(?i)\bexile[ds]?\b", content):
        result["contains_exile"] = 1.0

    # --- contains_queer ---
    if re.search(r"(?i)\bqueer\b", content):
        result["contains_queer"] = 1.0

    # --- contains_eccentric ---
    if re.search(r"(?i)\beccentric\b", content):
        result["contains_eccentric"] = 1.0

    # --- contains_exotic ---
    if re.search(r"(?i)\bexotic\b", content):
        result["contains_exotic"] = 1.0

    # --- contains_specialist_and_speciality ---
    # Simplified from lookahead regex to two separate checks to avoid potential
    # multiline matching issues.
    has_specialist = bool(re.search(r"(?i)\bspecialist\b", content))
    has_speciality = bool(re.search(r"(?i)\bspecialit(?:y|ies)\b", content))
    if has_specialist and has_speciality:
        result["contains_specialist_and_speciality"] = 1.0

    # --- contains_remaining_new_words ---
    # Checks the 4 new vocabulary words: particular, expert, odd, weird
    remaining_words = [
        r"(?i)\bparticular\b",
        r"(?i)\bexpert[s]?\b",
        r"(?i)\bodd\b",
        r"(?i)\bweird\b",
    ]
    found_remaining = sum(1 for pat in remaining_words if re.search(pat, content))
    if found_remaining == 4:
        result["contains_remaining_new_words"] = 1.0
    elif found_remaining >= 2:
        result["contains_remaining_new_words"] = 0.5

    # --- contains_review_words ---
    review_words = [
        r"(?i)\badventure\b",
        r"(?i)\bchallenge\b",
        r"(?i)\bsurvival\b",
        r"(?i)\bremote\b",
        r"(?i)\bcourage\b",
    ]
    found_review = sum(1 for pat in review_words if re.search(pat, content))
    if found_review == 5:
        result["contains_review_words"] = 1.0
    elif found_review >= 3:
        result["contains_review_words"] = 0.5

    # --- glossary_section_present ---
    if re.search(r"(?i)(glossary|vocabulary|word[s]?\s*explanation|definitions|key\s+terms|word\s+bank|new\s+words|words\s+to\s+know)", content):
        result["glossary_section_present"] = 1.0

    # --- discussion_questions_present ---
    if re.search(
        r"(?im)(discussion|thinking|thought|reflect\w*|comprehension|think\s+about)\s*(question|问题|it)?|"
        r"questions\s+for\s+(discussion|reflection|you)|"
        r"^#{1,4}\s+.*(question|reflect|discuss|think)",
        content
    ):
        result["discussion_questions_present"] = 1.0

    # --- no_mundane_trap_word ---
    if not re.search(r"(?i)\bmundane\b", content):
        result["no_mundane_trap_word"] = 1.0

    # --- word_count_in_range ---
    # Guidelines specify 380-440 words. Tolerance ±15 for partial credit.
    words = re.findall(r"\b[a-zA-Z']+\b", content)
    word_count = len(words)
    if 380 <= word_count <= 440:
        result["word_count_in_range"] = 1.0
    elif 365 <= word_count <= 460:
        result["word_count_in_range"] = 0.5

    # --- narrative_coherence_rescue_exotic ---
    paragraphs = re.split(r"\n\s*\n", content)
    for para in paragraphs:
        if re.search(r"(?i)\brescue[ds]?\b", para) and re.search(r"(?i)\bexotic\b", para):
            result["narrative_coherence_rescue_exotic"] = 1.0
            break

    # --- correct_team_size ---
    # Supplementary facts: 8 members. fact_check_log.json (trap) wrongly says 12.
    has_correct_size = bool(re.search(
        r"(?i)\b(8|eight)[\s\-]member|\b(8|eight)\s+rescuers?\b|\bteam\s+of\s+(8|eight)\b",
        content
    ))
    has_wrong_size = bool(re.search(
        r"(?i)\b12[\s\-]member|\b12\s+rescuers?\b|\bteam\s+of\s+12\b",
        content
    ))
    if has_correct_size and not has_wrong_size:
        result["correct_team_size"] = 1.0
    elif has_correct_size:
        result["correct_team_size"] = 0.5

    # --- correct_survival_days ---
    # news_event.md: five-day ordeal / 5 days. fact_check_log.json (trap) wrongly says 7 days.
    has_correct_days = bool(re.search(
        r"(?i)\bfive[\s\-]day\b|\b5[\s\-]day\b|\b5\s+days\b|\bfive\s+days\b",
        content
    ))
    has_wrong_days = bool(re.search(
        r"(?i)\bseven[\s\-]day\b|\b7[\s\-]day\b|\b7\s+days\b|\bseven\s+days\b",
        content
    ))
    if has_correct_days and not has_wrong_days:
        result["correct_survival_days"] = 1.0
    elif has_correct_days:
        result["correct_survival_days"] = 0.5

    # --- glossary_includes_cefr_levels ---
    # Guidelines require CEFR level (A1/A2/B1/B2/C1/C2) in each glossary entry,
    # drawn from reference/word_frequency_data.csv.
    cefr_pattern = r"(?i)\b(CEFR\s*:?\s*)?(A1|A2|B1|B2|C1|C2)\b"
    cefr_matches = re.findall(cefr_pattern, content)
    n_cefr = len(cefr_matches)
    if n_cefr >= 4:
        result["glossary_includes_cefr_levels"] = 1.0
    elif n_cefr >= 2:
        result["glossary_includes_cefr_levels"] = 0.5
    elif n_cefr >= 1:
        result["glossary_includes_cefr_levels"] = 0.25

    # --- glossary_count_four ---
    # Guidelines require exactly 4 glossary entries.
    # Count numbered items (1. 2. 3. ...) or bolded word entries within a glossary section.
    glossary_section_match = re.search(
        r"(?i)(glossary|key\s+terms|word[s]?\s*explanation|definitions|new\s+words)(.*?)(?=##|\Z)",
        content,
        re.DOTALL
    )
    n_glossary = 0
    if glossary_section_match:
        gloss_body = glossary_section_match.group(2)
        # Count numbered entries or bold-word entries
        numbered = re.findall(r"(?m)^\s*\d+\.\s+\S", gloss_body)
        bolded = re.findall(r"\*\*[A-Za-z]+\*\*", gloss_body)
        n_glossary = max(len(numbered), len(bolded))
    else:
        # Fallback: count bold word patterns anywhere in doc
        bolded_all = re.findall(r"\*\*[A-Za-z]+\*\*\s*\(?(?:CEFR|[AB][12]|C1|C2)?", content)
        n_glossary = len(bolded_all)

    if n_glossary == 4:
        result["glossary_count_four"] = 1.0
    elif 3 <= n_glossary <= 5:
        result["glossary_count_four"] = 0.5

    # --- vocab_coverage_section_present ---
    # Guidelines require a "Vocabulary Coverage" section at the end listing all 16 required words.
    if re.search(r"(?i)vocabulary\s+coverage|vocab\w*\s+check|required\s+words?\s+used", content):
        result["vocab_coverage_section_present"] = 1.0

    # --- support_packet_sources_correct ---
    if isinstance(support_data, dict):
        approved = support_data.get("approved_requirements_source")
        rejected = support_data.get("rejected_sources")
        if approved == "content/article_guidelines.yaml" and isinstance(rejected, list):
            required_rejections = {
                "content/editor_notes.json",
                "content/old_article_draft.md",
                "content/fact_check_log.json",
            }
            if required_rejections.issubset(set(rejected)):
                result["support_packet_sources_correct"] = 1.0
            elif len(required_rejections.intersection(set(rejected))) >= 2:
                result["support_packet_sources_correct"] = 0.5

    # --- support_packet_verified_facts ---
    if isinstance(support_data, dict):
        vf = support_data.get("verified_facts")
        if isinstance(vf, dict):
            checks = 0
            if isinstance(vf.get("rescue_team_size"), dict):
                if vf["rescue_team_size"].get("value") == 8 and vf["rescue_team_size"].get("source") == "content/supplementary_facts.md":
                    checks += 1
            if isinstance(vf.get("survival_duration_days"), dict):
                if vf["survival_duration_days"].get("value") == 5 and vf["survival_duration_days"].get("source") == "content/news_event.md":
                    checks += 1
            if isinstance(vf.get("lowest_temperature_celsius"), dict):
                if vf["lowest_temperature_celsius"].get("value") == 8 and vf["lowest_temperature_celsius"].get("source") == "content/supplementary_facts.md":
                    checks += 1
            if isinstance(vf.get("first_reporting_community"), dict):
                if vf["first_reporting_community"].get("value") == "Kadazan-Dusun" and vf["first_reporting_community"].get("source") == "content/supplementary_facts.md":
                    checks += 1
            if checks == 4:
                result["support_packet_verified_facts"] = 1.0
            elif checks >= 2:
                result["support_packet_verified_facts"] = 0.5

    # --- support_packet_glossary_cefr ---
    if isinstance(support_data, dict):
        glossary_cefr = support_data.get("glossary_cefr")
        if isinstance(glossary_cefr, list):
            valid_entries = 0
            for entry in glossary_cefr:
                if isinstance(entry, dict):
                    word = entry.get("word")
                    cefr = entry.get("cefr")
                    if isinstance(word, str) and isinstance(cefr, str) and re.fullmatch(r"(A1|A2|B1|B2|C1|C2)", cefr):
                        valid_entries += 1
            if valid_entries == 4 and len(glossary_cefr) == 4:
                result["support_packet_glossary_cefr"] = 1.0
            elif valid_entries >= 2:
                result["support_packet_glossary_cefr"] = 0.5

    # --- support_packet_word_coverage ---
    if isinstance(support_data, dict):
        coverage = support_data.get("required_word_coverage")
        if isinstance(coverage, dict):
            required_words = {
                "rescue", "particular", "specialist", "speciality", "expert",
                "eccentric", "odd", "weird", "queer", "exotic", "exile",
                "adventure", "challenge", "survival", "remote", "courage",
            }
            true_count = sum(1 for word in required_words if coverage.get(word) is True)
            if true_count == 16:
                result["support_packet_word_coverage"] = 1.0
            elif true_count >= 12:
                result["support_packet_word_coverage"] = 0.5

    return result
```

## LLM Judge Rubric

### Criterion 1: Trap Detection and Source Prioritization (Weight: 30%)
**Score 1.0**: The agent correctly identifies and resolves all three source conflicts: (1) uses vocabulary_new.json over old_article_draft.md, correctly including "queer" and "exile" while excluding "mundane" and "typical"; (2) recognizes that editor_notes.json is explicitly superseded and follows article_guidelines.yaml (4 glossary entries, 2 discussion questions, intermediate audience, no summary paragraph); (3) identifies that fact_check_log.json is an unverified draft and uses supplementary_facts.md for correct facts (8 team members, 5-day ordeal, 8°C temperatures, Kadazan-Dusun community). The reasoning is evident and consistent.
**Score 0.75**: Two of three traps are fully resolved with correct reasoning. The third is either partially resolved or silently mishandled — e.g., correct vocabulary but some wrong facts from fact_check_log.json, or correct facts but wrong glossary count.
**Score 0.5**: One trap resolved correctly with reasoning. Another partially resolved. The third leads to a clear error in the output (e.g., article says "12-member team," or uses superseded editor requirements like 5 discussion questions, or includes "mundane" as required vocabulary).
**Score 0.25**: The agent shows awareness of conflicts but resolves them poorly — falls for at least two traps, with incorrect vocabulary, wrong facts, or wrong formatting requirements in the output.
**Score 0.0**: No evidence of trap detection. The agent blindly uses whichever source it reads first, resulting in multiple errors across vocabulary, facts, and formatting.

### Criterion 2: Technical Precision and Cross-File Data Integration (Weight: 25%)
**Score 1.0**: The agent correctly uses `reference/word_frequency_data.csv` as an active data source: at least 4 glossary entries each include the precise CEFR difficulty level matching the CSV, the vocabulary coverage section lists all 16 required words, and the support packet accurately records the 4 glossary words, verified facts, and rejected stale sources. Word count is within 380-440. The task is completed as a real editorial package, not just a standalone article.
**Score 0.75**: Most technical requirements are met: CEFR levels are mostly correct, the support packet exists and is mostly accurate, or the word count is slightly outside the target range. Cross-file integration is evident but not complete.
**Score 0.5**: The article covers some technical requirements, but the support packet is partial, incomplete, or inaccurate. `word_frequency_data.csv` or the factual source files were only partly utilized.
**Score 0.25**: Minimal evidence of structured cross-file integration. The article may exist, but the support packet is missing or largely incorrect, and technical compliance is weak.
**Score 0.0**: No evidence of using the required reference files in a structured way. The task is treated as pure writing rather than editorial production.

### Criterion 3: Narrative Quality and Audience Fit (Weight: 25%)
**Score 1.0**: The article reads as a polished, engaging magazine feature for intermediate English learners. All 16 vocabulary words are woven naturally into the Borneo rescue narrative — not crammed in awkwardly. The story has a clear arc (setup, ordeal, rescue, recovery), integrates supplementary details vividly (the hornbill research, limestone karst terrain, survival on rainwater and wild fruit), and the tone is accessible yet substantive. The glossary definitions are genuinely helpful for intermediate learners.
**Score 0.75**: The article is well-written and mostly natural. Most vocabulary words integrate smoothly, though 2-3 feel slightly forced. The narrative arc is present but one element (setup, climax, or resolution) is thin. Supplementary facts are referenced but not always vividly integrated.
**Score 0.5**: Functional but reads more like a vocabulary exercise. Several words are conspicuously inserted without narrative purpose. The story is told but without compelling detail. Tone may be inconsistent or lean academic/stilted rather than magazine-feature style.
**Score 0.25**: Vocabulary words are awkwardly crammed in. The narrative is shallow or poorly structured. The tone is significantly mismatched for intermediate learners. Supplementary facts are barely used.
**Score 0.0**: The output is incoherent, reads as a disjointed list of vocabulary sentences, or fails to tell the Borneo rescue story meaningfully.

### Criterion 4: Structural Compliance and Editorial Deliverability (Weight: 20%)
**Score 1.0**: The article strictly follows the structure and formatting from `article_guidelines.yaml`: main narrative body followed by exactly 4 CEFR-annotated glossary entries, exactly 2 discussion questions, and a vocabulary coverage section. In addition, the support packet is clean, machine-readable, and complete enough for editorial QA handoff. Together they look like a realistic publish-ready submission.
**Score 0.75**: Structure is mostly correct with one deviation in either the article or the support packet, but the overall submission is still clearly usable by an editorial team.
**Score 0.5**: Multiple structural deviations across the article and/or the support packet. The deliverable is recognizable but would need substantial editorial cleanup.
**Score 0.25**: Major structural issues: missing multiple required sections, missing the support packet, or messy formatting that prevents practical reuse.
**Score 0.0**: The deliverables are incomplete or not usable in a realistic editorial workflow.
