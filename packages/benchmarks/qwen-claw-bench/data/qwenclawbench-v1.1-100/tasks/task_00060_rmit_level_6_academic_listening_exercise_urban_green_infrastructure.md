---
id: task_00060_rmit_level_6_academic_listening_exercise_urban_green_infrastructure
name: RMIT Level 6 Academic Listening Exercise — Urban Green Infrastructure
category: Data Analysis and Modeling
grading_type: hybrid
timeout_seconds: 1800
workspace_files:
- source: data/source_lecture_raw.txt
  dest: data/source_lecture_raw.txt
- source: data/rmit_l6_standards.json
  dest: data/rmit_l6_standards.json
- source: data/synonym_dictionary.json
  dest: data/synonym_dictionary.json
- source: config/exercise_template.md
  dest: config/exercise_template.md
- source: data/previous_exercise_example.md
  dest: data/previous_exercise_example.md
- source: data/topic_keywords.csv
  dest: data/topic_keywords.csv
- source: config/t1_ratio_guidelines.yaml
  dest: config/t1_ratio_guidelines.yaml
- source: data/lecture_statistics_reference.csv
  dest: data/lecture_statistics_reference.csv
- source: data/alt_source_lecture.txt
  dest: data/alt_source_lecture.txt
- source: data/exercise_bank_archive.json
  dest: data/exercise_bank_archive.json
- source: logs/validation_log_20240915.log
  dest: logs/validation_log_20240915.log
- source: logs/spell_check_results.log
  dest: logs/spell_check_results.log
- source: data/audio_timing_guide.csv
  dest: data/audio_timing_guide.csv
- source: config/output_format_spec.yaml
  dest: config/output_format_spec.yaml
- source: data/content_word_stoplist.txt
  dest: data/content_word_stoplist.txt
- source: data/distractor_words.csv
  dest: data/distractor_words.csv
grading_weights:
  automated: 0.45
  llm_judge: 0.55
subcategory: Text Parsing
---
## Prompt

I'm putting together an RMIT Level 6 academic English listening exercise on urban green infrastructure and I need your help assembling the full deliverable. All the raw materials are in the workspace — the source lecture text, the RMIT L6 standards spec, a synonym dictionary, a template, and a completed coral reef example you can use as a quality and format reference.

Here's what I need in the output file `output/listening_exercise.md`:

First, expand the source lecture (`data/source_lecture_raw.txt`) into a polished academic lecture that lands between 850 and 950 words. Keep the register semi-formal and academic. There are several supporting files in the workspace — review all of them carefully, as not all files necessarily agree on the same values.

Then, create 10–12 fill-in-the-blank listening comprehension questions based on the expanded lecture. Each answer should be limited to **one or two words AND/OR a number** (meaning answers can be: a single word, two words, a number alone, or a combination like "two words and a number").

The critical part: classify every question as either **T-1** (synonym substitution — the question stem paraphrases the lecture using synonyms) or **T-0** (the question stem closely mirrors the lecture wording). Consult `config/t1_ratio_guidelines.yaml` and `data/rmit_l6_standards.json` for the correct T-1 target ratio range and classification criteria. Note that the exercise archive may contain entries with non-standard parameters — use the current standards documents as your authority.

For each T-1 question, verify that the repetition rate does not exceed the maximum threshold specified in the guidelines. The repetition rate measures lexical overlap between the question stem and the corresponding lecture sentence; consult the guidelines file for the formula and for how to distinguish content words from function words. Document the repetition rate calculation for every T-1 question.

Finally, include these analysis sections:

1. **Answer Key** — A complete table with columns: Question number, Answer, Type (T-1 or T-0)
2. **Trap Analysis** — For each question, explain what makes it challenging for a listener (e.g., distractors, similar-sounding words, paraphrasing complexity, number precision requirements)
3. **Synonym Substitution Verification** — For every T-1 question only, provide:
   - The synonym pairs used
   - Content words extracted from both the lecture sentence and question stem
   - The repetition rate calculation showing the formula and result
   - Confirmation that the repetition rate is within the allowed threshold

Follow the structure in `config/exercise_template.md` and match the quality of the coral reef example in `data/previous_exercise_example.md`.

Save everything to `output/listening_exercise.md`.

## Expected Behavior

The agent produces a comprehensive RMIT Level 6 listening exercise at `output/listening_exercise.md` with all required sections, grounded in careful cross-referencing of workspace files.

A correct solution:

- Expands `data/source_lecture_raw.txt` to 850–950 words maintaining an academic, semi-formal register. Where the workspace contains multiple files covering the same statistics, the primary source lecture is treated as authoritative. Supporting reference files, alternative lecture versions, and summary spreadsheets that contain different numeric values or units for the same metrics are considered secondary sources and should not override the primary.
- Uses quantitative figures consistent with the primary source throughout — including correct numeric values and correct units for the stormwater, economic, and thermal data points. The reference CSV and the alternative lecture version each introduce at least one incorrect value or incorrect unit for figures that appear in the primary source.
- Applies the T-1 ratio as defined in `config/t1_ratio_guidelines.yaml` and `data/rmit_l6_standards.json`. The exercise archive contains at least one entry labelled as an updated standard with a substantially higher T-1 ratio; this entry does not reflect current standards and should not be used to set the target ratio.
- Correctly identifies content words using the stop-word list, applies the repetition rate formula from the guidelines, and documents the per-question calculation for all T-1 questions, confirming each meets the threshold.
- Provides an answer key with T-1/T-0 type labels for every question, a per-question trap analysis, and synonym substitution verification for all T-1 questions.

## Grading Criteria

- [ ] **output_file_exists**: Output file exists at `output/listening_exercise.md` and is non-empty.
- [ ] **expanded_lecture_section**: The output contains a section heading indicating an expanded or academic lecture.
- [ ] **lecture_word_count_in_range**: The expanded lecture section contains between 850 and 950 words (inclusive).
- [ ] **question_count_in_range**: Between 10 and 12 fill-in-the-blank questions are present in the output.
- [ ] **answer_key_section**: An Answer Key section is present in table format with type labels.
- [ ] **correct_runoff_stat**: The stormwater runoff reduction statistic is correctly stated as 35% in context (from the primary source, not the alternative 28% figure appearing in other workspace files).
- [ ] **no_incorrect_runoff_stat**: The incorrect runoff figure of 28% does not appear as a factual claim in the output.
- [ ] **correct_savings_unit**: The annual savings figure uses the correct unit "billion" from the primary source, not "million" as listed in the reference CSV.
- [ ] **t1_questions_labeled**: T-1 and T-0 type labels are present for questions.
- [ ] **t1_ratio_in_range**: The T-1 proportion in the answer key falls within the 35–40% range specified in the standards (not the inflated ratio from archived exercises).
- [ ] **no_elevated_t1_ratio**: The T-1 proportion does not exceed 45%, confirming the model did not apply the elevated T-1 ratio found in an exercise archive entry.
- [ ] **trap_analysis_section**: A per-question Trap Analysis section is present.
- [ ] **celsius_not_fahrenheit**: The temperature reduction is stated as 3.5°C (Celsius unit), not 3.5°F (as incorrectly listed in the reference CSV).

## Automated Checks

```python
import os
import re
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the listening exercise output file."""

    keys = [
        "output_file_exists",
        "expanded_lecture_section",
        "lecture_word_count_in_range",
        "question_count_in_range",
        "answer_key_section",
        "correct_runoff_stat",
        "no_incorrect_runoff_stat",
        "correct_savings_unit",
        "t1_questions_labeled",
        "t1_ratio_in_range",
        "no_elevated_t1_ratio",
        "trap_analysis_section",
        "celsius_not_fahrenheit",
    ]

    result = {k: 0.0 for k in keys}

    output_path = Path(workspace_path) / "output" / "listening_exercise.md"

    if not output_path.is_file():
        return result
    result["output_file_exists"] = 1.0

    content = output_path.read_text(encoding="utf-8", errors="replace")

    if not content or not content.strip():
        return result

    # ── Expanded lecture section ─────────────────────────────────────────────
    lecture_heading_re = re.compile(
        r'^#{1,4}\s+.*(?:Expanded|Academic|Polished).*(?:Lecture|Text).*$|'
        r'^#{1,4}\s+.*Lecture.*(?:Expanded|Academic|Polished).*$',
        re.IGNORECASE | re.MULTILINE
    )
    lecture_match = lecture_heading_re.search(content)
    if lecture_match:
        result["expanded_lecture_section"] = 1.0

    # ── Lecture word count 850–950 ───────────────────────────────────────────
    if lecture_match:
        l_start = lecture_match.end()
        next_h = re.search(r'^#{1,4}\s+', content[l_start:], re.MULTILINE)
        lecture_section = content[l_start:l_start + next_h.start()] if next_h else content[l_start:]
        word_count = len([w for w in lecture_section.split() if w.strip()])
        if 850 <= word_count <= 950:
            result["lecture_word_count_in_range"] = 1.0
        elif 800 <= word_count <= 1000:
            result["lecture_word_count_in_range"] = 0.5

    # ── Question count 10–12 ────────────────────────────────────────────────
    # Primary: numbered lines with blank indicators (___)
    q_blank = re.findall(
        r'^\s*(\d+)\s*[\.\)]\s+.+(?:_{3,}|\[_+\]|\[\s*\])',
        content, re.IGNORECASE | re.MULTILINE
    )
    q_numbers = set(int(n) for n in q_blank)

    if not q_numbers:
        # Fallback: numbered items in a questions section
        q_sec_match = re.search(
            r'^#{1,4}\s+.*(?:Fill[- ]in[- ]the[- ]Blank|Questions|Comprehension).*$',
            content, re.IGNORECASE | re.MULTILINE
        )
        if q_sec_match:
            qs = q_sec_match.end()
            m2 = re.search(r'^#{1,4}\s+', content[qs:], re.MULTILINE)
            q_sec = content[qs:qs + m2.start()] if m2 else content[qs:]
            fb_nums = re.findall(r'^\s*(\d+)\s*[\.\)]\s+', q_sec, re.MULTILINE)
            q_numbers = set(int(n) for n in fb_nums if 1 <= int(n) <= 15)

    question_count = len(q_numbers)
    if 10 <= question_count <= 12:
        result["question_count_in_range"] = 1.0
    elif 8 <= question_count <= 14:
        result["question_count_in_range"] = 0.5

    # ── Answer key section ──────────────────────────────────────────────────
    ak_re = re.compile(r'^#{1,4}\s+Answer\s+Key\s*$', re.IGNORECASE | re.MULTILINE)
    ak_match = ak_re.search(content)
    if ak_match:
        result["answer_key_section"] = 1.0

    # Extract answer key section for T-1/T-0 ratio checks
    ak_section = ""
    if ak_match:
        ak_start = ak_match.end()
        m2 = re.search(r'^#{1,4}\s+', content[ak_start:], re.MULTILINE)
        ak_section = content[ak_start:ak_start + m2.start()] if m2 else content[ak_start:]

    # ── Correct runoff stat: 35% in stormwater/runoff context ───────────────
    has_35_near_runoff = bool(
        re.search(r'35\s*%[^\n.]{0,120}(?:runoff|stormwater|drainage)', content, re.IGNORECASE) or
        re.search(r'(?:runoff|stormwater|drainage)[^\n.]{0,120}35\s*%', content, re.IGNORECASE)
    )
    if has_35_near_runoff:
        result["correct_runoff_stat"] = 1.0
    elif re.search(r'35\s*%', content):
        result["correct_runoff_stat"] = 0.75
    elif re.search(r'(?:runoff|stormwater)', content, re.IGNORECASE):
        result["correct_runoff_stat"] = 0.5

    # ── No incorrect runoff stat: 28% should not appear as factual claim ────
    has_28 = bool(re.search(r'28\s*%', content))
    if not has_28:
        result["no_incorrect_runoff_stat"] = 1.0
    else:
        # Partial: 28% mentioned alongside 35% (likely trap discussion / rejection)
        if re.search(r'35\s*%', content):
            result["no_incorrect_runoff_stat"] = 0.5

    # ── Correct savings unit: billion (not million for $2.7) ─────────────────
    has_billion = bool(re.search(r'\bbillion\b', content, re.IGNORECASE))
    has_million_2_7 = bool(re.search(r'2\.7\s*million|million[^.]{0,30}2\.7', content, re.IGNORECASE))
    if has_billion and not has_million_2_7:
        result["correct_savings_unit"] = 1.0
    elif has_billion and has_million_2_7:
        result["correct_savings_unit"] = 0.5  # both present (possible trap discussion)
    elif has_million_2_7:
        result["correct_savings_unit"] = 0.0  # wrong unit used as factual claim

    # ── T-1 labels present ──────────────────────────────────────────────────
    if re.search(r'\bT-1\b', content):
        result["t1_questions_labeled"] = 1.0
    elif re.search(r'\bT-0\b', content):
        result["t1_questions_labeled"] = 0.5

    # ── T-1 ratio in range 35–40% ────────────────────────────────────────────
    search_text = ak_section if ak_section else content
    t1_count = len(re.findall(r'\bT-1\b', search_text))
    t0_count = len(re.findall(r'\bT-0\b', search_text))
    total_labeled = t1_count + t0_count

    if total_labeled >= 10:
        ratio = t1_count / total_labeled
        if 0.35 <= ratio <= 0.40:
            result["t1_ratio_in_range"] = 1.0
        elif 0.30 <= ratio <= 0.45:
            result["t1_ratio_in_range"] = 0.5

    # ── No elevated T-1 ratio (Trap: archive entry uses 55%) ────────────────
    if total_labeled >= 10:
        ratio = t1_count / total_labeled
        if ratio > 0.45:
            result["no_elevated_t1_ratio"] = 0.0   # significantly above standard
        elif ratio <= 0.40:
            result["no_elevated_t1_ratio"] = 1.0   # within or below ceiling
        else:
            result["no_elevated_t1_ratio"] = 0.75  # slightly above 40% ceiling
    else:
        # Can't verify from labels; partial credit if document references 35-40% range
        if re.search(r'35\s*[–\-]\s*40\s*%|35\s*%.*T-1|T-1.*35\s*%', content, re.IGNORECASE):
            result["no_elevated_t1_ratio"] = 0.5

    # ── Trap Analysis section ────────────────────────────────────────────────
    if re.search(r'^#{1,4}\s+.*Trap\s+Analysis.*$', content, re.IGNORECASE | re.MULTILINE):
        result["trap_analysis_section"] = 1.0

    # ── Celsius not Fahrenheit: 3.5°C in same passage ───────────────────────
    paragraphs = content.split('\n\n')
    celsius_near_35 = False
    found_35 = False
    found_celsius_unit = False
    for para in paragraphs:
        has_35 = bool(re.search(r'3\.5', para))
        has_celsius = bool(re.search(r'°C|℃|Celsius|\bC\b.*degrees|degrees.*\bC\b', para, re.IGNORECASE))
        if has_35:
            found_35 = True
        if has_celsius:
            found_celsius_unit = True
        if has_35 and has_celsius:
            celsius_near_35 = True
            break
    if celsius_near_35:
        result["celsius_not_fahrenheit"] = 1.0
    elif found_35 and found_celsius_unit:
        result["celsius_not_fahrenheit"] = 0.75
    elif found_35:
        result["celsius_not_fahrenheit"] = 0.5

    return result
```

## LLM Judge Rubric

### Criterion 1: Data Source Resolution and Cross-File Accuracy (Weight: 40%)
**Score 1.0**: The expanded lecture correctly resolves all four data conflicts present across workspace files: (1) uses 35% for stormwater runoff reduction, sourced from the primary lecture rather than the 28% figure in the alternative lecture version and the statistics reference CSV; (2) uses $2.7 billion (not million) for annual savings, correctly applying the primary source unit and rejecting the unit mismatch in the reference CSV; (3) uses 3.5°C (not °F) for temperature reduction, correctly applying the primary source unit and rejecting the unit error in the reference CSV; (4) applies the T-1 ratio of 35–40% as specified in the standards files, not the inflated ratio found in an archived exercise entry that claims to reflect an updated standard. Values are consistent throughout all sections (lecture, answer key, analysis).

**Score 0.75**: Three of the four conflicts are correctly resolved with evidence of source comparison. One is resolved incorrectly or without clear justification.

**Score 0.5**: Two of the four conflicts are correctly resolved. The agent showed some cross-referencing but relied on the most accessible value for the other two, resulting in at least two incorrect figures.

**Score 0.25**: At most one conflict resolved correctly. Agent appears to have used secondary sources (reference CSV, archive, alternative lecture) without checking against the primary source.

**Score 0.0**: No conflicts resolved correctly. Agent used values from secondary or conflicting sources throughout.

### Criterion 2: Academic Lecture Quality and Coherence (Weight: 25%)
**Score 1.0**: The expanded lecture is polished, cohesive academic prose with a semi-formal register appropriate for RMIT Level 6. It has a clear introduction, logically organized body sections with smooth transitions, and a conclusion. The expansion from the raw source is substantive — adding depth, context, and elaboration without introducing fabricated statistics. The lecture would be convincing as authentic listening material and word count is within 850–950.

**Score 0.75**: Well-organized and appropriate register. Minor padding in one or two passages, but no fabricated data and overall quality is suitable.

**Score 0.5**: Generally coherent but with uneven register, awkward transitions, or sections that feel like filler. Content is factually grounded but prose quality is inconsistent.

**Score 0.25**: Significant coherence problems — disjointed paragraphs, abrupt shifts, or padding with generic statements. Academic register poorly maintained or unsupported claims introduced.

**Score 0.0**: Incoherent, largely fabricated, no academic register, or essentially a copy of the raw source.

### Criterion 3: Question Design, T-1/T-0 Classification Integrity, and Repetition Rate Accuracy (Weight: 35%)
**Score 1.0**: All three dimensions are strong: (a) Questions test meaningful comprehension across diverse lecture content with unambiguous answers constrained to one–two words or a number; (b) T-1 questions use genuine synonym substitution with meaningfully paraphrased stems; T-0 questions mirror lecture wording; ratio is 35–40%; (c) Repetition rate calculations for all T-1 questions are mathematically correct — content words are correctly identified using the stoplist, shared words accurately counted, the formula from the guidelines correctly applied, and all cited repetition rates are at or below the 40% threshold. Synonym pairs represent genuine meaning equivalence drawn from the synonym dictionary.

**Score 0.75**: Questions are well-designed and T-1 classifications are mostly justified. Repetition rate calculations are present and mostly correct with minor arithmetic errors in one or two cases. T-1 ratio is within or very close to range.

**Score 0.5**: Questions are functional but some are superficial or have ambiguous answers. T-1 labels are present but some classifications are questionable (minimal paraphrasing). Repetition rate calculations are present but systematically incorrect (wrong content word identification, formula misapplied to multiple questions).

**Score 0.25**: Questions poorly distributed, ambiguous answers, T-1/T-0 distinctions arbitrary. Repetition rate calculations missing for most T-1 questions or formula consistently misapplied with no evidence of using the stoplist.

**Score 0.0**: Questions generic or disconnected from the lecture. T-1/T-0 classification absent or entirely incorrect. No valid repetition rate calculations. The question set would not function as a valid listening exercise.
