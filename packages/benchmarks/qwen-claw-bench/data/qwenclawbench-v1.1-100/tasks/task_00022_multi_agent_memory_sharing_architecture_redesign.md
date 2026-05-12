---
id: task_00022_multi_agent_memory_sharing_architecture_redesign
name: Multi-Agent Memory Sharing Architecture Redesign
category: Workflow and Agent Orchestration
grading_type: hybrid
timeout_seconds: 1800
grading_weights:
  automated: 0.45
  llm_judge: 0.55
workspace_files:
- source: config/agent_registry.yaml
  dest: config/agent_registry.yaml
- source: config/data_classification_policy.yaml
  dest: config/data_classification_policy.yaml
- source: config/sync_config.json
  dest: config/sync_config.json
- source: config/legacy_sync_config.json
  dest: config/legacy_sync_config.json
- source: config/interim_sync_config.json
  dest: config/interim_sync_config.json
- source: config/encryption_settings.yaml
  dest: config/encryption_settings.yaml
- source: data/agent_memory_audit_log.csv
  dest: data/agent_memory_audit_log.csv
- source: data/knowledge_graph_snapshot.json
  dest: data/knowledge_graph_snapshot.json
- source: data/conflict_incidents.json
  dest: data/conflict_incidents.json
- source: data/agent_capabilities_matrix.csv
  dest: data/agent_capabilities_matrix.csv
- source: data/sharing_topology.json
  dest: data/sharing_topology.json
- source: data/storage_metrics.csv
  dest: data/storage_metrics.csv
- source: docs/current_architecture.md
  dest: docs/current_architecture.md
- source: docs/compliance_requirements.md
  dest: docs/compliance_requirements.md
- source: docs/vendor_comparison_embeddings.md
  dest: docs/vendor_comparison_embeddings.md
- source: logs/memory_sync_errors.log
  dest: logs/memory_sync_errors.log
subcategory: Agent and AI Orchestration
---
## Prompt

We've been running a multi-agent AI system with five specialized agents (research, coding, customer service, analytics, and ops) and frankly, the shared memory architecture is a mess. We've had data loss from write conflicts, possible compliance violations, and I'm pretty sure some of our configuration files are contradicting each other — but I haven't had time to untangle it all.

Everything you need is in the workspace: agent registry, data classification policies, multiple sync configuration files (including what looks like a newer version), audit logs, conflict incident reports, the current architecture docs, compliance requirements, a knowledge graph snapshot, sharing topology, capability matrices, sync error logs, and a few other files. Some of these might be outdated, superseded, or mutually inconsistent — and newer-looking files aren't necessarily the right ones to trust. Cross-reference everything carefully, verify which sources are actually authoritative before drawing conclusions, and watch for contradictions that span multiple files.

What I need from you is a comprehensive redesign document saved to `multi_agent_memory_sharing_design.md`. It should:

- Audit the current state by analyzing the conflict incidents, audit logs, and error logs to quantify what's actually going wrong and how often
- Identify every configuration inconsistency, policy violation, and design flaw you can find across all the files — especially anything where one file says one thing and another contradicts it
- Propose a new memory sharing architecture that properly handles namespace isolation, conflict resolution (something better than last-write-wins), data classification enforcement, and compliance with the retention/encryption/PII requirements
- Lay out specific recommendations for the sync mechanism, access control model, and how the knowledge graph should handle cross-classification references
- Include a migration path from the current architecture to the proposed one

Be thorough. This is going to the architecture review board and I need it to hold up to scrutiny. If you find things that are broken or contradictory in the current setup, call them out explicitly with file references.

## Expected Behavior

The agent should produce a comprehensive architecture redesign document (`multi_agent_memory_sharing_design.md`) that demonstrates careful analysis of all workspace files and correctly navigates five traps:

**Trap 1 — Legacy Sync Config (outdated_data):**
The agent must recognize that `config/legacy_sync_config.json` is an outdated configuration file (dated 2023-01-15) and that `config/sync_config.json` (version 3.1.0, status: active) is the current authoritative source. The correct default sync interval is 300 seconds (from `sync_config.json`), NOT 3600 seconds (from the legacy file). The current conflict resolution strategy is `last_write_wins`, not `first_write_wins`. The agent should explicitly flag the legacy config as outdated and warn that it should be archived or deleted to prevent confusion. The agent should use the current sync config's values (including the customer_agent's 60-second override) when analyzing and proposing improvements.

**Trap 2 — PII Masking Contradiction (contradictory):**
The agent must identify that `config/data_classification_policy.yaml` requires PII masking for confidential data before sharing, but `config/encryption_settings.yaml` has `pii_masking_enabled: false`. This is a critical compliance violation. The design document should flag this contradiction explicitly, reference both files, and the proposed architecture must enforce PII masking as required by the classification policy (the policy is authoritative over the runtime encryption settings).

**Trap 3 — Restricted Data Sharing Violation (misleading_context):**
The agent must discover that `data/sharing_topology.json` includes "restricted" as an allowed data category in the ops_agent→analytics_agent sharing edge, which directly violates `config/data_classification_policy.yaml` where restricted data is defined as "never share." The agent should flag this as a policy violation, note that the classification policy is authoritative, and ensure the proposed architecture enforces the prohibition on sharing restricted data. The audit log (`data/agent_memory_audit_log.csv`) corroborates this — 15 rows show denied attempts to share restricted data.

**Trap 4 — Draft Config Misdirection (misleading_context):**
The workspace contains `config/interim_sync_config.json` with version 3.5.0 and an update timestamp of 2024-11-10 — both higher/newer than `config/sync_config.json` (v3.1.0, 2024-10-15). An agent that naively trusts version numbers or timestamps as proxies for authority will incorrectly use the interim file's settings (600-second default interval, `timestamp_wins` conflict resolution). However, `config/interim_sync_config.json` is explicitly marked `"status": "draft"` and states it is "NOT YET ACTIVE." The only authoritative active configuration is `config/sync_config.json`. The agent must correctly identify the interim config as a non-authoritative draft, avoid using its settings as a baseline for analysis or recommendations, and note that `timestamp_wins` is not a meaningful improvement over `last_write_wins` — it still loses data whenever two writes occur within the same timestamp resolution window.

**Trap 5 — Data Retention Violations (outdated_data):**
The agent must discover that two restricted-classification nodes in `data/knowledge_graph_snapshot.json` have exceeded their 30-day retention limit as of the snapshot date (2024-11-14): `kg_023` (Database Connection Strings, last_updated: 2024-10-04, age: 41 days) and `kg_029` (API Key Rotation Schedule, last_updated: 2024-10-10, age: 35 days). Both violate the maximum 30-day retention limit for restricted data defined in `docs/compliance_requirements.md` and `config/data_classification_policy.yaml`. These nodes should have been automatically purged. Their continued presence in the graph means live restricted credential metadata has been retained beyond the permitted window and is actively accessible to agents — a compliance violation requiring immediate remediation.

**Additional required findings:**
- Analyze the 25 conflict incidents from `data/conflict_incidents.json` and identify that all 4 data-loss incidents resulted from the `last_write_wins` conflict resolution strategy, recommending a superior approach (e.g., CRDT, optimistic concurrency with vector clocks, or operational transforms)
- Identify ALL cross-classification dependency violations in `data/knowledge_graph_snapshot.json` where lower-classification nodes reference higher-classification nodes, creating information leakage paths. The required findings include at minimum: `kg_026` (public) → `kg_016` (confidential), `kg_028` (public) → `kg_009` (confidential), `kg_028` (public) → `kg_023` (restricted — the most severe, as a public node directly references restricted credential data), and `kg_006` (public) → `kg_008` (confidential). The agent must identify the restricted leakage path specifically and explain why it is more severe than the confidential ones.
- Address all compliance requirements from `docs/compliance_requirements.md` including GDPR-like PII handling, audit trails, encryption requirements, and data retention limits (public: unlimited, internal: 365 days, confidential: 90 days, restricted: 30 days)
- Reference the sync error logs in `logs/memory_sync_errors.log` for evidence of version conflicts, repeated KMS key rotation failures (3 incidents), and lock timeout issues
- Identify from `data/agent_memory_audit_log.csv` that in addition to the 15 denied restricted sharing attempts, there are also 3 successful restricted data share operations (these represent actual security breaches requiring immediate remediation) AND 4 instances where restricted data was written directly to the shared namespace by agents other than restricted-level ops_agent (analytics_agent at 2024-10-16, customer_agent ×2 at 2024-10-21, ops_agent at 2024-10-30) — these write violations are a distinct and more severe category than the sharing violations, demonstrating that the system fails to prevent restricted data from entering shared storage entirely
- Ignore or appropriately contextualize noise files like `data/storage_metrics.csv` and `docs/vendor_comparison_embeddings.md` — these provide operational background but should not drive architecture decisions

## Grading Criteria

- [ ] The output file `multi_agent_memory_sharing_design.md` exists and is a well-structured Markdown document with clear sections
- [ ] The document correctly identifies `config/legacy_sync_config.json` as outdated, uses `config/sync_config.json` as authoritative, and cites BOTH the 300-second default interval AND the customer_agent's 60-second override (partial credit if only 300 is cited)
- [ ] The document explicitly flags the PII masking contradiction by citing BOTH `config/data_classification_policy.yaml` AND `config/encryption_settings.yaml` by filename in the same paragraph alongside the PII masking issue (citing only one file is insufficient)
- [ ] The document identifies the restricted data sharing violation in `data/sharing_topology.json` (ops_agent→analytics_agent edge) and correctly states that restricted data must never be shared per the classification policy
- [ ] The document analyzes conflict incidents and identifies that all 4 data-loss events were caused by `last_write_wins`, citing the count of 4 explicitly (partial credit if last_write_wins + data_loss are connected but count is omitted)
- [ ] The document names a specific superior conflict resolution algorithm — must explicitly use one of: CRDT, vector clock, vector_clock, or operational transform (generic phrases like "better conflict resolution" do not qualify)
- [ ] The document identifies the most severe knowledge graph cross-classification violation: a public-classification node referencing a restricted-classification node, with at least one specific cross-classification path involving "restricted" cited (not only confidential violations)
- [ ] The document cites all three non-unlimited data retention limits from the classification policy: 365 days (internal), 90 days (confidential), and 30 days (restricted), within a retention/compliance context (partial credit for two of three)
- [ ] The document identifies that the `data/agent_capabilities_matrix.csv` access controls are declarative only and not enforced at runtime — the current system has no row-level or column-level enforcement mechanism
- [ ] The document includes a phased migration or transition plan (must include "phased" or numbered phases — a generic single-step migration does not qualify)
- [ ] The document correctly counts all three quantitative evidence points: 15 denied restricted share attempts (from audit log), 25 total conflict incidents (from conflict_incidents.json), and 4 data-loss events (partial credit for two of three)
- [ ] The document does not treat noise files (storage_metrics.csv, vendor_comparison_embeddings.md) as primary architectural inputs
- [ ] The document correctly identifies `config/interim_sync_config.json` as a non-authoritative draft AND explicitly critiques `timestamp_wins` as not a meaningful improvement over `last_write_wins` (partial credit if only the draft status is identified)
- [ ] The document identifies at least three specific cross-classification dependency paths in the knowledge graph by node ID pair (partial credit for two paths; one path scores 0.25)
- [ ] The document identifies BOTH retention violations by name: `kg_023` (41 days, restricted, exceeds 30-day limit) AND `kg_029` (35 days, restricted, exceeds 30-day limit) (partial credit if only one node is identified)
- [ ] The document flags that restricted data was written directly to the shared namespace AND distinguishes these 4 write-to-shared violations as a separate and more severe category from the 3 sharing violations (partial credit if write violations are mentioned without the distinction)

## Automated Checks

```python
import os
import re
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the multi_agent_memory_sharing_design.md output file."""

    output_file = "multi_agent_memory_sharing_design.md"
    filepath = os.path.join(workspace_path, output_file)

    # Initialize all scores to 0.0
    results = {
        "file_exists_check": 0.0,
        "private_vs_shared_section": 0.0,
        "retention_days_per_tier_cited": 0.0,
        "correct_audit_log_counts": 0.0,
        "both_sync_intervals_cited": 0.0,
        "no_legacy_sync_interval": 0.0,
        "pii_masking_addressed": 0.0,
        "named_crdt_or_vector_clock": 0.0,
        "last_write_wins_critique": 0.0,
        "pii_masking_both_files_cited": 0.0,
        "capabilities_matrix_not_enforced": 0.0,
        "restricted_sharing_violation": 0.0,
        "knowledge_graph_flaw": 0.0,
        "two_year_log_retention_cited": 0.0,
        "migration_path_mentioned": 0.0,
        "draft_config_not_trusted": 0.0,
        "retention_violation_identified": 0.0,
        "restricted_write_to_shared": 0.0,
        "multiple_cross_classification_paths": 0.0,
    }

    # file_exists_check: The output design document was created
    if not os.path.isfile(filepath):
        return results

    results["file_exists_check"] = 1.0

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return results

    content_lower = content.lower()
    paragraphs = re.split(r"\n\s*\n", content)

    # ── private_vs_shared_section ──
    # Requires per-agent private namespace explicitly separated from shared storage in an
    # architectural context — not just a generic mention of "private vs shared".
    pattern_pvs = re.compile(
        r"(?i)(private|personal|individual).{0,30}(shared|common|public).{0,30}(partition|separation|boundary|division|storage)"
    )
    if pattern_pvs.search(content):
        results["private_vs_shared_section"] = 1.0

    # ── retention_days_per_tier_cited ──
    # Score 1.0 if all three non-unlimited retention durations appear near a retention/classification
    # context: 365 days (internal), 90 days (confidential), 30 days (restricted).
    # Score 0.5 if exactly two of the three appear in retention context.
    def _near_retention(num_pattern, text):
        return bool(re.search(
            r"(retention|purge|day|expire|limit).{0,60}" + num_pattern +
            r"|" + num_pattern + r".{0,60}(retention|purge|day|expire|limit)",
            text
        ))
    found_retention = sum([
        _near_retention(r"\b365\b", content_lower),
        _near_retention(r"\b90\b", content_lower),
        _near_retention(r"\b30\b", content_lower),
    ])
    if found_retention == 3:
        results["retention_days_per_tier_cited"] = 1.0
    elif found_retention == 2:
        results["retention_days_per_tier_cited"] = 0.5

    # ── correct_audit_log_counts ──
    # Score 1.0 if all three quantitative facts are present: 15 denied restricted share attempts,
    # 25 total conflict incidents, and 4 data-loss incidents.
    # Score 0.5 if exactly two of the three are present in the appropriate context.
    has_15_denied = bool(
        re.search(r'\b15\b.{0,80}(denied|restrict|block)', content_lower) or
        re.search(r'(denied|restrict|block).{0,80}\b15\b', content_lower)
    )
    has_25_incidents = bool(
        re.search(r'\b25\b.{0,80}(incident|conflict)', content_lower) or
        re.search(r'(incident|conflict).{0,80}\b25\b', content_lower)
    )
    has_4_loss = bool(
        re.search(r'\b4\b.{0,60}(data.loss|data-loss)', content_lower) or
        re.search(r'(data.loss|data-loss).{0,60}\b4\b', content_lower)
    )
    found_counts = sum([has_15_denied, has_25_incidents, has_4_loss])
    if found_counts == 3:
        results["correct_audit_log_counts"] = 1.0
    elif found_counts == 2:
        results["correct_audit_log_counts"] = 0.5

    # ── both_sync_intervals_cited ──
    # Score 1.0 if BOTH the 300-second default interval AND the customer_agent's 60-second override
    # are cited (60 must appear in a customer_agent context, not just anywhere).
    # Score 0.5 if only the 300-second default is cited.
    has_300 = bool(re.search(r'\b300\b', content))
    has_60_customer = False
    for para in paragraphs:
        para_lower = para.lower()
        if re.search(r'\b60\b', para_lower) and re.search(r'customer.agent|customer_agent', para_lower):
            has_60_customer = True
            break
    if has_300 and has_60_customer:
        results["both_sync_intervals_cited"] = 1.0
    elif has_300:
        results["both_sync_intervals_cited"] = 0.5

    # ── no_legacy_sync_interval ──
    # Score 1.0 when the legacy interval of 3600s is NOT adopted as a recommendation.
    # Agents may legitimately cite 3600 when criticising the legacy config.
    if not re.search(r'\b3600\b', content_lower):
        results["no_legacy_sync_interval"] = 1.0
    else:
        legacy_ctx = re.search(
            r'(legacy|outdated|deprecated|old|obsolete).{0,100}3600|3600.{0,100}(legacy|outdated|deprecated|old|obsolete)',
            content_lower
        )
        if legacy_ctx:
            results["no_legacy_sync_interval"] = 1.0

    # ── pii_masking_addressed ──
    # "PII" and "masking" must appear in the same paragraph alongside a conflict/contradiction
    # signal, demonstrating the agent flagged the policy vs encryption_settings inconsistency.
    for para in paragraphs:
        para_lower = para.lower()
        has_pii = bool(re.search(r"\bpii\b", para_lower))
        has_masking = bool(re.search(r"\bmasking\b", para_lower))
        has_conflict_signal = bool(re.search(
            r"(false|disabled|contradiction|contradict|conflict|violation|mismatch|inconsisten|encryption_settings)",
            para_lower
        ))
        if has_pii and has_masking and has_conflict_signal:
            results["pii_masking_addressed"] = 1.0
            break

    # ── named_crdt_or_vector_clock ──
    # Score 1.0 if the document explicitly names a specific conflict resolution algorithm
    # superior to last_write_wins. Generic phrases ("better conflict resolution") do NOT qualify.
    # Must be one of: CRDT, vector clock, vector_clock, operational transform.
    pattern_algo = re.compile(
        r"(?i)\b(crdt|vector.clock|vector_clock|operational.transform|operation.transform)\b"
    )
    if pattern_algo.search(content):
        results["named_crdt_or_vector_clock"] = 1.0

    # ── last_write_wins_critique ──
    # Score 1.0 if "last_write_wins" + "data_loss" + the count "4" all appear in the same paragraph.
    # Score 0.5 if last_write_wins and data_loss are connected but the count 4 is absent.
    for para in paragraphs:
        para_lower = para.lower()
        has_lww = bool(re.search(r"last.write.wins", para_lower))
        has_dl = bool(re.search(r"data.loss|data-loss", para_lower))
        has_count = bool(re.search(
            r"(\b4\b|four).{0,60}(data.loss|data-loss|incident|case)|"
            r"(data.loss|data-loss|incident|case).{0,60}(\b4\b|four)",
            para_lower
        ))
        if has_lww and has_dl:
            if has_count:
                results["last_write_wins_critique"] = 1.0
            else:
                results["last_write_wins_critique"] = max(results["last_write_wins_critique"], 0.5)

    # ── pii_masking_both_files_cited ──
    # Score 1.0 if BOTH config filenames (data_classification_policy and encryption_settings)
    # appear in the same paragraph alongside a PII/masking reference.
    # Score 0.5 if both filenames appear somewhere in the document with at least one in a
    # PII/masking context — demonstrating cross-referencing but in separate paragraphs.
    # Citing only one file is insufficient for full marks.
    _doc_has_policy = bool(re.search(r"data_classification_policy|data.classification.policy", content_lower))
    _doc_has_enc = bool(re.search(r"encryption_settings|encryption.settings", content_lower))
    for para in paragraphs:
        para_lower = para.lower()
        has_policy_file = bool(re.search(
            r"data_classification_policy|data.classification.policy", para_lower
        ))
        has_enc_file = bool(re.search(
            r"encryption_settings|encryption.settings", para_lower
        ))
        has_pii_masking = bool(re.search(
            r"\bpii\b.{0,80}\bmasking\b|\bmasking\b.{0,80}\bpii\b|pii.masking|masking.*disabled|pii.*disabled",
            para_lower
        ))
        if has_policy_file and has_enc_file and has_pii_masking:
            results["pii_masking_both_files_cited"] = 1.0
            break
        if has_pii_masking and (has_policy_file or has_enc_file) and _doc_has_policy and _doc_has_enc:
            results["pii_masking_both_files_cited"] = max(results["pii_masking_both_files_cited"], 0.5)

    # ── capabilities_matrix_not_enforced ──
    # Score 1.0 if the document identifies that agent_capabilities_matrix.csv access controls
    # are declarative only and not enforced at runtime — the system has no row-level or
    # column-level enforcement mechanism (confirmed by docs/current_architecture.md).
    for para in paragraphs:
        para_lower = para.lower()
        has_no_enforcement = bool(re.search(
            r"(not.enforc|unenforc|declarative|no.row.level|row.level.*access|no.*access.control.*enforc|"
            r"access.control.*not.*enforc|matrix.*not.*enforc|capabilities.*not.*enforc|"
            r"policy.only|policy.without.*enforc|no.runtime.enforc|runtime.*not.*enforc|"
            r"enforc.*absent|no.enforc.*mechanism|without.*runtime.*control)",
            para_lower
        ))
        has_matrix_ref = bool(re.search(
            r"(capabilities.matrix|capability.matrix|access.matrix|agent.*matrix|"
            r"agent_capabilities_matrix|capabilities_matrix)",
            para_lower
        ))
        if has_no_enforcement and has_matrix_ref:
            results["capabilities_matrix_not_enforced"] = 1.0
            break

    # ── restricted_sharing_violation ──
    # "restricted" and "violation" must appear in the same paragraph AND the paragraph must
    # reference the specific ops_agent→analytics_agent sharing edge or the topology file.
    for para in paragraphs:
        para_lower = para.lower()
        has_restricted = bool(re.search(r"\brestricted\b", para_lower))
        has_violation = bool(re.search(r"\bviolation\b", para_lower))
        has_agent_ref = bool(re.search(
            r"(ops.agent|analytics.agent|ops.*analytics|analytics.*ops|sharing.topology|topology)",
            para_lower
        ))
        if has_restricted and has_violation and has_agent_ref:
            results["restricted_sharing_violation"] = 1.0
            break

    # ── knowledge_graph_flaw ──
    # Score 1.0 if the document identifies the most severe cross-classification violation:
    # a public-classification node referencing a RESTRICTED-classification node in the knowledge graph.
    # Must find "knowledge_graph" + "public" + "restricted" + a leakage/dependency term
    # in the same paragraph. Identifying only confidential violations is insufficient.
    for para in paragraphs:
        para_lower = para.lower()
        has_kg = bool(re.search(r"knowledge.graph", para_lower))
        has_public = bool(re.search(r"\bpublic\b", para_lower))
        has_restricted = bool(re.search(r"\brestricted\b", para_lower))
        has_leakage = bool(re.search(r"(leakage|leak|reference|depend|cross.classif)", para_lower))
        if has_kg and has_public and has_restricted and has_leakage:
            results["knowledge_graph_flaw"] = 1.0
            break

    # ── two_year_log_retention_cited ──
    # Score 1.0 if the document cites the specific 2-year audit log retention requirement
    # from compliance_requirements.md §4.3. Mentioning "audit trail" alone is insufficient —
    # the specific retention duration must appear in a log/audit context.
    pattern_2yr = re.compile(
        r"(?i)(2.year|two.year|2-year|730.day|24.month).{0,80}(audit|log|retain|retent)"
        r"|"
        r"(audit|log|retain|retent).{0,80}(2.year|two.year|2-year|730.day|24.month)"
    )
    if pattern_2yr.search(content):
        results["two_year_log_retention_cited"] = 1.0

    # ── migration_path_mentioned ──
    # Score 1.0 if the document includes a phased migration or transition plan.
    # A generic single-sentence migration mention does not qualify —
    # must explicitly use "phased" or numbered phase structure.
    pattern_mig = re.compile(
        r"(?i)(phased.migration|phased.rollout|phased.transition|migration.*phase|phase.*migration|"
        r"phase\s+[1-9]|step\s+[1-9].{0,30}migrat|migrat.{0,30}step\s+[1-9]|"
        r"rollout.*phase|phase.*rollout)"
    )
    if pattern_mig.search(content):
        results["migration_path_mentioned"] = 1.0

    # ── draft_config_not_trusted ──
    # Score 1.0 if the document identifies the interim config as a non-authoritative draft
    # AND explicitly critiques timestamp_wins as not a meaningful improvement over last_write_wins.
    # Score 0.5 if only the draft status is identified without the timestamp_wins critique.
    for para in paragraphs:
        para_lower = para.lower()
        has_draft_signal = bool(re.search(
            r"(draft|not.yet.active|not.active|non.authoritative|not.authoritative|not.deployed|not.in.use)",
            para_lower
        ))
        has_config_ref = bool(re.search(
            r"(interim.sync|interim_sync|3\.5\.0|3\.5|interim.*config|config.*interim)",
            para_lower
        ))
        if has_draft_signal and has_config_ref:
            has_ts_critique = bool(re.search(
                r"(timestamp.wins|timestamp_wins)",
                para_lower
            ))
            if has_ts_critique:
                results["draft_config_not_trusted"] = 1.0
            else:
                results["draft_config_not_trusted"] = max(results["draft_config_not_trusted"], 0.5)

    # ── retention_violation_identified ──
    # Score 1.0 if BOTH overdue restricted nodes are identified: kg_023 AND kg_029.
    # Score 0.5 if only one of the two nodes is identified alongside a retention violation term.
    has_retention_term = bool(re.search(
        r"(retention.violation|exceed.*retention|retention.*exceed|30.day|30-day|overdue|"
        r"should.*purge|not.*purge|past.*retention|beyond.*retention)",
        content_lower
    ))
    has_kg023 = bool(re.search(r"kg_023|database.connection.string", content_lower))
    has_kg029 = bool(re.search(r"kg_029|api.key.rotation.schedule", content_lower))
    if has_retention_term and has_kg023 and has_kg029:
        results["retention_violation_identified"] = 1.0
    elif has_retention_term and (has_kg023 or has_kg029):
        results["retention_violation_identified"] = 0.5

    # ── restricted_write_to_shared ──
    # Score 1.0 if the document flags restricted data writes to the shared namespace AND
    # explicitly distinguishes these write violations as separate/more severe from the share violations.
    # Score 0.5 if the write violations are mentioned without the distinction.
    for para in paragraphs:
        para_lower = para.lower()
        has_write_op = bool(re.search(
            r"(writ|wrote).{0,100}(shared.namespace|shared.storage|shared.*restrict|restrict.*shared|shared.*space)",
            para_lower
        ))
        has_violation = bool(re.search(
            r"(violation|violat|breach|prohibit|must.never|policy.*block|block.*policy)",
            para_lower
        ))
        has_distinction = bool(re.search(
            r"(distinct|separate|different.from|beyond.shar|in.addition.to.shar|"
            r"not.just.shar|separate.categor|\b4\b.{0,40}write|\bwrite\b.{0,40}\b4\b)",
            para_lower
        ))
        if has_write_op and has_violation:
            if has_distinction:
                results["restricted_write_to_shared"] = 1.0
            else:
                results["restricted_write_to_shared"] = max(results["restricted_write_to_shared"], 0.5)

    # ── multiple_cross_classification_paths ──
    # Score 1.0 if the document identifies 3+ specific cross-classification paths by node ID.
    # Score 0.5 if exactly 2 paths are identified.
    # Score 0.25 if only 1 path is identified.
    # The most severe path is kg_028 (public) → kg_023 (restricted).
    cross_class_patterns = [
        r"kg_026.{0,80}kg_016|kg_016.{0,80}kg_026",
        r"kg_028.{0,80}kg_009|kg_009.{0,80}kg_028",
        r"kg_028.{0,80}kg_023|kg_023.{0,80}kg_028",
        r"kg_006.{0,80}kg_008|kg_008.{0,80}kg_006",
    ]
    cross_class_count = sum(
        1 for pat in cross_class_patterns if re.search(pat, content_lower)
    )
    if cross_class_count >= 3:
        results["multiple_cross_classification_paths"] = 1.0
    elif cross_class_count == 2:
        results["multiple_cross_classification_paths"] = 0.5
    elif cross_class_count == 1:
        results["multiple_cross_classification_paths"] = 0.25

    return results
```

## LLM Judge Rubric

### Criterion 1: Depth and Accuracy of Cross-File Analysis and Trap Resolution (Weight: 40%)
**Score 1.0**: The document demonstrates rigorous cross-referencing across all workspace files and correctly resolves all five traps. For Trap 1, the agent explicitly identifies the legacy sync config by date/version, explains why it is outdated, and warns about archiving/deleting it. For Trap 2, the agent pinpoints both files by name, explains the compliance risk of disabled PII masking, and clearly states the classification policy takes precedence. For Trap 3, the agent identifies the specific ops_agent→analytics_agent edge, cites the "never share" restriction from the policy, and explains the severity. For Trap 4, the agent correctly identifies `config/interim_sync_config.json` as a non-authoritative draft (citing its `status: draft` and "NOT YET ACTIVE" note), avoids using its settings, and explains why `timestamp_wins` is not a meaningful improvement over `last_write_wins`. For Trap 5, the agent identifies both `kg_023` (41 days old) and `kg_029` (35 days old) as restricted nodes exceeding the 30-day retention limit, citing the snapshot date and specific last_updated values. All five traps are resolved with correct reasoning chains grounded in the actual file contents.
**Score 0.75**: Four of the five traps are correctly identified and resolved with sound reasoning. The fifth is either missed entirely or the reasoning is shallow — for example, the agent notes the draft config exists but doesn't explain why it is non-authoritative, or identifies retention violations but without citing specific node dates.
**Score 0.5**: Three of the five traps are correctly identified and resolved. Two are missed or incorrectly resolved (e.g., agent treats `interim_sync_config.json` as authoritative due to higher version, or misses retention violations entirely, or trusts the legacy sync interval).
**Score 0.25**: Only one or two traps are correctly identified. The agent takes most configurations at face value, misses the draft config misdirection or retention violations, and fails to demonstrate multi-file cross-referencing for the trap resolution.
**Score 0.0**: None of the five traps are correctly identified, or the document shows no evidence of cross-referencing files and treats all configurations as equally authoritative without verification.

### Criterion 2: Architecture Proposal Quality and Technical Soundness (Weight: 35%)
**Score 1.0**: The proposed architecture is comprehensive, technically sound, and directly addresses every identified flaw. It includes a well-reasoned conflict resolution strategy superior to both last-write-wins and timestamp_wins (e.g., vector clocks, CRDTs, or operational transforms) with clear justification for the choice. Namespace isolation is designed with specificity (e.g., per-agent namespaces, access control matrices tied to classification tiers). The architecture includes technical enforcement mechanisms for data classification — not just declarative policies but runtime controls such as automated PII detection, sharing gateways, policy-as-code validation, or write-time classification enforcement that would prevent restricted data writes to shared storage. Automated retention enforcement with per-classification purge jobs is proposed. Knowledge graph design is addressed with classification boundary enforcement to prevent cross-classification dependencies. Migration/rollout from the current broken state is addressed with phased steps. The design choices flow logically from the audit findings.
**Score 0.75**: The architecture is technically sound and addresses most identified flaws. Conflict resolution and namespace isolation are well-designed, but one or two areas are underdeveloped — for example, retention enforcement is mentioned but not designed in detail, or the knowledge graph fix is generic rather than specific to the identified cross-classification paths, or the migration plan lacks phasing.
**Score 0.5**: The architecture addresses the major issues but is partially generic or boilerplate. Proposals lack specificity to the five-agent system. Enforcement mechanisms are described in policy terms only without technical controls. The retention violation or restricted write prevention is not addressed architecturally.
**Score 0.25**: The architecture is superficial, consisting mostly of high-level recommendations without concrete technical design. It reads more like a list of best practices than a redesign tailored to the analyzed system. Critical components like enforcement mechanisms, retention automation, or migration paths are missing.
**Score 0.0**: No coherent architecture is proposed, or the proposed design would perpetuate or worsen the existing problems (e.g., adopts timestamp_wins from the draft config without critique, doesn't enforce classification tiers, ignores retention requirements).

### Criterion 3: Professional Document Quality, Quantitative Rigor, and Completeness (Weight: 25%)
**Score 1.0**: The document is well-structured with clear sections flowing logically from audit/analysis → findings → architecture proposal → implementation guidance. Quantitative analysis is precise and grounded in the actual data: correctly counts 15 denied restricted share attempts, 3 successful restricted share breaches, AND 4 restricted data writes to shared namespace (distinguishing these as two separate violation categories); cites the 25 conflict incidents with 4 data-loss events; calculates retention violation ages from specific node dates; identifies at least 2 specific cross-classification paths in the knowledge graph by node ID. All claims are consistently tied to specific file references rather than vague assertions. The writing is clear, precise, and appropriate for a technical architecture review board audience. No hallucinated data or fabricated statistics are present.
**Score 0.75**: The document is well-organized and mostly grounded in workspace data. Quantitative analysis is mostly correct but may miss one category (e.g., counts the share violations but not the write violations, or identifies cross-classification issues without citing specific node IDs). Claims are generally file-referenced but with occasional gaps. Overall still reads as a professional deliverable.
**Score 0.5**: The document covers the required topics but has noticeable quality issues: quantitative claims are imprecise or partially correct (e.g., conflates write violations with share violations, or cites incorrect violation counts), some sections are underdeveloped, or the logical flow between findings and recommendations has gaps. File references are inconsistent.
**Score 0.25**: The document is disorganized with significant gaps in coverage. Quantitative claims appear estimated or hallucinated rather than derived from the actual data files. Multiple findings are unsupported by specific file references. The document would not withstand scrutiny at an architecture review board.
**Score 0.0**: The document is incoherent, largely hallucinated, or so incomplete that it fails to serve as an architecture redesign document. Major sections are missing or filled with generic content unrelated to the specific workspace data.