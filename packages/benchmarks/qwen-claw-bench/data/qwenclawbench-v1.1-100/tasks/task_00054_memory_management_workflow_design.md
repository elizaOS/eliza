---
id: task_00054_memory_management_workflow_design
name: Memory Management Workflow Design
category: Knowledge and Memory Management
grading_type: hybrid
timeout_seconds: 1800
workspace_files:
- source: config/assistant_config.yaml
  dest: config/assistant_config.yaml
- source: config/storage_limits.json
  dest: config/storage_limits.json
- source: data/memories.json
  dest: data/memories.json
- source: data/recurring_schedule.csv
  dest: data/recurring_schedule.csv
- source: logs/memory_operations.log
  dest: logs/memory_operations.log
- source: logs/cleanup_history.log
  dest: logs/cleanup_history.log
- source: docs/memory_architecture_v1.md
  dest: docs/memory_architecture_v1.md
- source: docs/user_requirements.md
  dest: docs/user_requirements.md
- source: docs/competitor_analysis.md
  dest: docs/competitor_analysis.md
- source: config/cron_schedules.ini
  dest: config/cron_schedules.ini
- source: data/memory_categories.json
  dest: data/memory_categories.json
- source: scripts/cleanup_pseudocode.txt
  dest: scripts/cleanup_pseudocode.txt
- source: data/user_feedback.csv
  dest: data/user_feedback.csv
- source: config/embedding_config.yaml
  dest: config/embedding_config.yaml
grading_weights:
  automated: 0.55
  llm_judge: 0.45
subcategory: Memory and Context Management
---
## Prompt

So here's the situation — we've been running our AI assistant's memory system for a few months now and it's... not great. Users are complaining about outdated info being surfaced, duplicates piling up, and the cleanup jobs don't seem to be doing their job. I've been meaning to do a proper audit and redesign but haven't had the bandwidth.

Everything you need is in the workspace: configs, the actual memory store, operation logs, cleanup history, the old architecture doc, user requirements, scheduling configs, and some other supporting files. There's a lot there and I suspect not all of it is consistent — we've had multiple people touching these configs over time and I wouldn't be surprised if things have drifted.

What I need from you is a comprehensive workflow design document saved to `memory_workflow_design.md`. It should cover:

- An audit of the current state: what's actually configured, what's actually running, where things are broken or inconsistent across the various config files and logs. Don't just take any single file at face value — cross-reference them.
- A diagnosis of why the memory system is degrading (stale items, duplicates, missed cleanups, etc.), backed by evidence from the logs and data files.
- A redesigned workflow for memory management that addresses the user requirements, including how recurring vs. ad-hoc items should be handled, retention policies, deduplication strategy, cleanup scheduling, and categorization.
- Specific recommendations for resolving any configuration conflicts you find — which values should be authoritative and why.
- A section on the embedding/vector search setup and whether the current configuration would actually work for similarity-based duplicate detection.

- A **self-check procedures** section: describe specifically how the system should periodically audit its own state — what checks should run automatically, at what frequency, what conditions should trigger alerts (approaching storage limits, failed cleanups, detected near-duplicates), and how the system validates that its scheduled jobs are actually executing as intended.

Be thorough. I'd rather have a document that's too detailed than one that glosses over real issues. If you find files that contradict each other, call it out explicitly and recommend the correct resolution.

## Expected Behavior

The agent must produce a comprehensive `memory_workflow_design.md` that demonstrates careful cross-referencing of all workspace files and correctly identifies the three key traps:

**Trap 1 — Contradictory Storage Limits:**
The agent should identify that `config/assistant_config.yaml` specifies `max_memory_items: 500` and `retention_days: 90`, while `config/storage_limits.json` specifies `max_memory_items: 5000` and `retention_days: 30`. These directly contradict each other. The correct resolution is to align with the primary config (`assistant_config.yaml`) for the 90-day retention, while noting that `docs/user_requirements.md` requires support for at least 1000 items — meaning the 500 limit in the primary config is also insufficient and needs to be raised to at least 1000, but the 5000 in `storage_limits.json` is not the authoritative value. The agent should NOT blindly adopt either file's values without reconciliation.

**Trap 2 — Cleanup Schedule Inconsistency:**
Three sources provide conflicting information about cleanup scheduling:
- `config/cron_schedules.ini` configures cleanup as weekly (cron: `0 2 * * 0`)
- `logs/cleanup_history.log` header text claims "Cleanup runs daily at 02:00 UTC"
- Actual timestamps in `cleanup_history.log` show only 6 runs in 90 days at irregular intervals
- `logs/memory_operations.log` corroborates that cleanup has only run twice in the last 60 days

The agent should identify that the cron config says weekly, the log header misleadingly says daily, and the actual execution is far less frequent than either. The correct answer is that the intended schedule is weekly (per `cron_schedules.ini`), but the job is failing to execute reliably. The agent should NOT trust the cleanup_history.log header claim of "daily."

**Trap 3 — Embedding Model Mismatch:**
`config/assistant_config.yaml` references `embedding_model: text-embedding-ada-002` (which produces 1536-dimensional vectors), while `config/embedding_config.yaml` references `text-embedding-ada-001` with `vector_dimensions: 1024`. These are incompatible. The correct model is `text-embedding-ada-002` with 1536 dimensions (from the primary config). The agent should flag that using the wrong model/dimensions would cause silent failures in similarity-based duplicate detection, which is critical for the deduplication requirement.

**Additional correct analysis should include:**
- Identifying the 8 stale memories in `data/memories.json` with `last_accessed` dates older than 90 days that should have been cleaned up (items with `"expired": true`: Dentist toothbrush recommendation, Team lunch poll, Water office plants, Backup files reminder, Grocery shopping list, Blue Bottle coffee shop, Osteria Mozza restaurant, Parking garage code)
- Identifying the 3 near-duplicate memory pairs that need deduplication: (1) two standup meeting items ("Daily standup: discuss blockers..." and "The standup meeting covers blockers..."); (2) two weekly report items ("Weekly report submission due every Friday..." and "Weekly report is due Friday by 5 PM..."); (3) two BP medication items ("Take blood pressure medication at 8:00 AM" and "Remember to take BP medication every morning at 8 AM")
- Noting that the `[memory_summary]` cron job in `config/cron_schedules.ini` has `enabled = false`, meaning summarization **never runs** — this directly violates user_requirements.md Req 3 ("summarization runs before any deletion"). Every cleanup log entry confirms `items_summarized=0`. The agent should flag this as a critical gap that needs to be enabled.
- Noting that the v1 architecture (`docs/memory_architecture_v1.md`) was designed for only 100 items with no deduplication or summarization
- Noting that 3 items in `data/recurring_schedule.csv` are inactive and should be reviewed
- Noting the 5 ERROR entries in `memory_operations.log` for failed writes due to storage issues
- Noting the 3 WARN entries about approaching storage limits
- Proposing a redesigned workflow that separates recurring and ad-hoc item handling, implements priority-based retention, enables vector-based deduplication, and establishes reliable cleanup scheduling
- The agent should largely ignore `docs/competitor_analysis.md` as it contains marketing fluff without actionable technical substance

## Grading Criteria

- [ ] The output file `memory_workflow_design.md` exists and is a well-structured Markdown document with clear sections
- [ ] Correctly identifies the contradiction between `config/assistant_config.yaml` (max_memory_items: 500, retention_days: 90) and `config/storage_limits.json` (max_memory_items: 5000, retention_days: 30) and recommends resolution favoring the primary config while raising the limit to meet the 1000-item user requirement
- [ ] Correctly identifies the cleanup scheduling inconsistency across `config/cron_schedules.ini` (weekly), `logs/cleanup_history.log` header (claims daily), and actual log timestamps (irregular/infrequent), and does NOT adopt the misleading "daily" claim from the log header
- [ ] Correctly identifies the embedding model mismatch between `config/assistant_config.yaml` (text-embedding-ada-002, 1536 dims) and `config/embedding_config.yaml` (text-embedding-ada-001, 1024 dims) and explains the impact on duplicate detection
- [ ] Provides evidence-based diagnosis of memory system degradation referencing specific log entries (ERROR entries for failed writes, WARN entries for storage limits, infrequent CLEANUP_RUN entries)
- [ ] Identifies stale memories (items with last_accessed older than 90 days) and near-duplicate items in `data/memories.json`
- [ ] Proposes a redesigned workflow that addresses: separation of recurring vs. ad-hoc items, priority-based retention, deduplication strategy, reliable cleanup scheduling, and categorization/searchability
- [ ] Cross-references `docs/user_requirements.md` requirements against current system capabilities and identifies specific gaps
- [ ] Does not treat `docs/competitor_analysis.md` as a source of actionable technical recommendations
- [ ] Document is comprehensive, internally consistent, and provides specific actionable recommendations rather than vague suggestions

## Automated Checks

```python
import os
import re
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the memory_workflow_design.md output file."""
    
    results = {
        "file_exists_check": 0.0,
        "recurring_items_section": 0.0,
        "ad_hoc_items_section": 0.0,
        "self_check_section": 0.0,
        "storage_config_contradiction": 0.0,
        "summarization_disabled_issue": 0.0,
        "deduplication_process": 0.0,
        "embedding_mismatch_identified": 0.0,
        "cleanup_frequency_recommendation": 0.0,
        "retention_policy_defined": 0.0,
        "priority_based_retention": 0.0,
        "log_evidence_cited": 0.0,
        "category_taxonomy_used": 0.0,
        "specific_memory_ids_cited": 0.0,
        "quantified_issues_identified": 0.0,
    }
    
    output_path = os.path.join(workspace_path, "memory_workflow_design.md")
    
    # file_exists_check
    if not os.path.isfile(output_path):
        return results
    
    results["file_exists_check"] = 1.0
    
    try:
        with open(output_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return results
    
    content_lower = content.lower()
    
    # --- section_exists checks ---
    # recurring_items_section: Look for a markdown heading containing "Recurring"
    if re.search(r"^#{1,4}\s+.*\bRecurring\b", content, re.MULTILINE | re.IGNORECASE):
        results["recurring_items_section"] = 1.0
    
    # ad_hoc_items_section: Look for a markdown heading containing "Ad-Hoc" or "Ad Hoc"
    if re.search(r"^#{1,4}\s+.*\bAd[-\s]Hoc\b", content, re.MULTILINE | re.IGNORECASE):
        results["ad_hoc_items_section"] = 1.0
    
    # self_check_section: Look for a markdown heading containing "Self-Check" or "Self Check"
    if re.search(r"^#{1,4}\s+.*\bSelf[-\s]Check\b", content, re.MULTILINE | re.IGNORECASE):
        results["self_check_section"] = 1.0
    
    # --- content_contains checks ---
    # storage_config_contradiction: Grading Criteria item 2 — agent identifies the conflict between
    # assistant_config.yaml (max_memory_items: 500, retention_days: 90) and storage_limits.json
    # (max_memory_items: 5000, retention_days: 30) and recommends reconciliation.
    # Original: only checked for "contradict" — synonyms like "conflict", "inconsistent",
    # "mismatch", "discrepancy" all correctly describe the same issue but would fail the check.
    # Broadened: accept any of the common conflict-description terms.
    if re.search(r"\b(contradict\w*|conflict\w*|inconsisten\w*|mismatch\w*|discrepanc\w*)\b", content_lower):
        results["storage_config_contradiction"] = 1.0
    
    # summarization_disabled_issue: the key issue is that summarization is DISABLED in
    # cron_schedules.ini ([memory_summary] enabled = false) AND items_summarized=0 in every
    # cleanup log entry — meaning no memory is ever summarized before deletion, directly
    # violating user_requirements.md Req 3 (summarization before deletion).
    # Original: only checked for "summariz" anywhere — any document mentioning summarization
    # as a desired feature (without noting it's currently disabled) would score 1.0.
    # Strengthened: give full credit when the disabled/not-running state is identified alongside
    # summarization; partial credit for any summarization mention.
    has_summariz = bool(re.search(r"\bsummariz\w*\b", content_lower))
    has_disabled_context = bool(re.search(
        r'(?i)(summariz.{0,80}(disabled|not.running|never.runs|enabled.*false|items_summarized.*0|0.*items_summarized)|'
        r'(disabled|not.running|never.runs|enabled.*false|items_summarized.*0).{0,80}summariz)',
        content
    ))
    if has_summariz and has_disabled_context:
        results["summarization_disabled_issue"] = 1.0
    elif has_summariz:
        results["summarization_disabled_issue"] = 0.5
    
    # deduplication_process: Document mentions "dedup" (dedup, deduplication, deduplicate, etc.)
    if re.search(r"\bdedup\w*\b", content_lower):
        results["deduplication_process"] = 1.0
    
    # --- regex_match checks ---
    # embedding_mismatch_identified: Grading Criteria item 4 — identify that assistant_config.yaml
    # uses text-embedding-ada-002 (1536 dims) while embedding_config.yaml uses text-embedding-ada-001
    # (1024 dims), causing silent failures in deduplication.
    # Original: (ada-001|1024|dimension|mismatch|outdated.*model|vector.*dimension)
    # "dimension" alone matches any document discussing vectors; "mismatch" without context is
    # too generic. Narrowed: require ada-001 specifically, or the 1024-dimension figure in
    # embedding context, or an explicit model conflict/incompatibility term.
    pattern_embedding = r"(ada-001|text-embedding-ada-001|1024.{0,30}(dim|vector)|" \
                        r"(dim|vector).{0,30}1024|incompatible.{0,40}embed|embed.{0,40}incompatible|" \
                        r"model.{0,30}(mismatch|conflict|incompatible)|(mismatch|conflict|incompatible).{0,30}model)"
    if re.search(pattern_embedding, content, re.IGNORECASE | re.DOTALL):
        results["embedding_mismatch_identified"] = 1.0
    elif re.search(r'(?i)(ada-002.*ada-001|ada-001.*ada-002)', content):
        results["embedding_mismatch_identified"] = 1.0
    
    # cleanup_frequency_recommendation: Grading Criteria item 3 — agent must identify the CORRECT
    # intended schedule as WEEKLY (per cron_schedules.ini: "0 2 * * 0") and NOT adopt the
    # misleading "daily" claim from cleanup_history.log's header.
    # Original: matched (daily|every day|24 hour|...) which rewards the WRONG answer — an agent
    # who says "cleanup should run daily" (the Trap 2 log header claim) scores 1.0, while an agent
    # who correctly identifies weekly scheduling fails. This is exactly backwards.
    # Fix: give full credit when "weekly" appears in cleanup scheduling context AND the document
    # does NOT endorse daily cleanup as the target; partial credit if schedule is addressed without
    # endorsing daily; 0.0 if daily cleanup is recommended as the correct target.
    has_weekly_cleanup = bool(re.search(
        r'(?i)(\bweekly\b.{0,60}clean|clean.{0,60}\bweekly\b|0\s+2\s+\*\s+\*\s+0|'
        r'weekly.{0,40}schedul|schedul.{0,40}weekly)',
        content
    ))
    endorses_daily_cleanup = bool(re.search(
        r'(?i)(cleanup|clean[\s-]up).{0,50}\bdaily\b|\bdaily\b.{0,50}(cleanup|clean[\s-]up)',
        content
    ))
    if has_weekly_cleanup and not endorses_daily_cleanup:
        results["cleanup_frequency_recommendation"] = 1.0
    elif not endorses_daily_cleanup and re.search(r'(?i)(cleanup|clean[\s-]up).{0,40}schedul|schedul.{0,40}(cleanup|clean[\s-]up)', content):
        results["cleanup_frequency_recommendation"] = 0.5
    
    # retention_policy_defined: matches (retention|expire|expir|TTL|time.to.live).*\d+
    pattern_retention = r"(retention|expire|expir|TTL|time.to.live).*\d+"
    if re.search(pattern_retention, content, re.IGNORECASE | re.DOTALL):
        results["retention_policy_defined"] = 1.0
    
    # --- content_near check ---
    # priority_based_retention: "priority" and "retention" appear in the same paragraph
    paragraphs = re.split(r"\n\s*\n", content)
    for para in paragraphs:
        para_lower = para.lower()
        if re.search(r"\bpriority\b", para_lower) and re.search(r"\bretention\b", para_lower):
            results["priority_based_retention"] = 1.0
            break
    
    # --- log_evidence_cited ---
    # Grading Criteria item 5: "evidence-based diagnosis referencing specific log entries
    # (ERROR entries for failed writes, WARN entries for storage limits, infrequent CLEANUP_RUN
    # entries)." Replaced no_competitor_buzzwords which checked for absence of "quantum memory
    # indexing" — a phrase that never appears in practice, so this was a free 1.0 for everyone.
    # This check verifies that the agent actually cited concrete evidence from the operation logs.
    has_error_evidence = bool(re.search(
        r'(?i)(ERROR|failed.{0,20}write|disk.write.timeout|IOError)', content
    ))
    has_warn_evidence = bool(re.search(
        r'(?i)(WARN|storage.{0,30}warning|storage.{0,30}capacity|83\s*%|81\s*%|80\s*%)', content
    ))
    has_cleanup_evidence = bool(re.search(
        r'(?i)(CLEANUP_RUN|cleanup.run|6.{0,20}runs|cleanup.{0,30}infrequent|cleanup.{0,30}irregular)', content
    ))
    if has_error_evidence and (has_warn_evidence or has_cleanup_evidence):
        results["log_evidence_cited"] = 1.0
    elif has_error_evidence or (has_warn_evidence and has_cleanup_evidence):
        results["log_evidence_cited"] = 0.5
    
    # --- regex_match ---
    # category_taxonomy_used: matches (categor|work|personal|reference|temporary|classif)
    pattern_category = r"(categor|work|personal|reference|temporary|classif)"
    if re.search(pattern_category, content, re.IGNORECASE):
        results["category_taxonomy_used"] = 1.0
    
    # Require specific stale or duplicate memory identifiers to be cited
    memory_ids = re.findall(r'MEM[-_]?\d+|mem[-_]?\d+|memory[-_]id[-_]?\d+', content, re.IGNORECASE)
    unique_memory_ids = set(memory_ids)
    results["specific_memory_ids_cited"] = 1.0 if len(unique_memory_ids) >= 3 else (0.5 if len(unique_memory_ids) >= 1 else 0.0)
    
    # Check for specific quantified stale/duplicate counts
    stale_count = re.search(r'\b[3-9]\s*(?:stale|过期|陈旧)|stale.{0,30}\b[3-9]\b', content, re.IGNORECASE)
    duplicate_count = re.search(r'\b[2-9]\s*(?:duplicate|重复|duplicated)|duplicate.{0,30}\b[2-9]\b', content, re.IGNORECASE)
    results["quantified_issues_identified"] = 1.0 if (stale_count and duplicate_count) else (0.5 if (stale_count or duplicate_count) else 0.0)
    
    return results
```

## LLM Judge Rubric

### Criterion 1: Cross-Referencing Depth and Trap Resolution Quality (Weight: 40%)
**Score 1.0**: The document demonstrates rigorous cross-referencing across all workspace files. All three traps are not only identified but correctly resolved with precise reasoning: (1) the storage limit contradiction is resolved by reconciling the primary config's 90-day retention with the user requirement of ≥1000 items, explicitly rejecting both the 500 and 5000 values as-is; (2) the cleanup schedule inconsistency is dissected by distinguishing the cron config (weekly), the misleading log header (daily), and the actual execution pattern (irregular/sparse), with the agent correctly identifying that weekly is the intended schedule but execution is failing; (3) the embedding model mismatch is traced to its downstream impact on similarity-based deduplication, explaining why duplicate detection is silently failing. Evidence from specific files and log entries is cited throughout.
**Score 0.75**: All three traps are identified and mostly correctly resolved, but one trap's resolution lacks full precision (e.g., the agent identifies the embedding mismatch but doesn't fully connect it to deduplication failures, or identifies the cleanup inconsistency but doesn't clearly distinguish which source is authoritative). Cross-referencing is evident across most files but may miss one minor connection.
**Score 0.5**: Two of the three traps are correctly identified and resolved, or all three are identified but resolutions are superficial (e.g., noting contradictions exist without determining which values are correct or why). Cross-referencing is present but inconsistent — some conclusions rely on a single source rather than triangulating across files.
**Score 0.25**: Only one trap is correctly identified and resolved. The document shows limited cross-referencing, largely taking individual files at face value. Analysis may contain errors such as trusting the cleanup log header's "daily" claim or blindly adopting storage_limits.json values.
**Score 0.0**: No traps are correctly identified. The document treats files in isolation, fails to notice contradictions, or presents hallucinated findings not grounded in the workspace data.

### Criterion 2: Diagnostic Reasoning and Evidence-Based Root Cause Analysis (Weight: 30%)
**Score 1.0**: The document provides a compelling, evidence-backed causal chain explaining why the memory system is degrading. It connects specific configuration errors and operational failures to observed symptoms (stale items ← missed cleanups ← cron job not executing reliably; duplicates ← embedding dimension mismatch breaking similarity search; outdated info ← retention policy confusion between conflicting configs). Log timestamps, operation counts, and data patterns are cited as concrete evidence. The diagnosis distinguishes between configuration drift, execution failures, and design flaws.
**Score 0.75**: The diagnostic reasoning is mostly sound and evidence-based, connecting most symptoms to root causes with supporting data. One causal chain may be incomplete or one symptom's root cause may be stated without sufficient evidence from the logs/data.
**Score 0.5**: The document identifies symptoms and proposes plausible root causes, but the reasoning is partially speculative or lacks specific evidence citations. Some connections between configuration issues and observed problems are asserted rather than demonstrated.
**Score 0.25**: The diagnosis is largely generic (e.g., "cleanup isn't running enough" without explaining why or citing evidence). Root causes are guessed at rather than derived from the data. The analysis reads more like general best practices than a specific audit.
**Score 0.0**: No meaningful diagnostic reasoning is present. The document jumps to recommendations without analyzing what is actually broken or why, or the diagnosis is factually incorrect based on the workspace data.

### Criterion 3: Redesigned Workflow Coherence and Practical Completeness (Weight: 30%)
**Score 1.0**: The redesigned workflow is a cohesive, implementable system that directly addresses every identified problem and user requirement. It specifies concrete parameters (not just "increase retention" but specific values justified by the analysis), defines clear decision logic for how items flow through categorization → deduplication → storage → retention review → cleanup, and accounts for edge cases (e.g., what happens when storage limits are approached, how priority interacts with retention, how recurring items are updated vs. duplicated). The workflow is internally consistent — no part contradicts another — and includes operational safeguards (monitoring, alerting on missed cleanups, validation of embedding dimensions).
**Score 0.75**: The workflow is well-structured and addresses the major issues with specific parameters, but may lack detail in one area (e.g., edge case handling, monitoring/alerting, or the interaction between subsystems). The design is internally consistent and clearly implementable.
**Score 0.5**: The workflow covers the main components (deduplication, retention, cleanup, categorization) but is somewhat generic or lacks specificity in key areas. Some recommendations feel disconnected from the audit findings, or the workflow has minor internal inconsistencies.
**Score 0.25**: The workflow is incomplete, covering only some aspects of memory management, or is largely a list of generic best practices without tailoring to the specific problems identified in the audit. Key components like the interaction between retention and priority are missing.
**Score 0.0**: No coherent workflow is presented, or the proposed design would not resolve the identified problems. The recommendations are vague platitudes without actionable specifics.