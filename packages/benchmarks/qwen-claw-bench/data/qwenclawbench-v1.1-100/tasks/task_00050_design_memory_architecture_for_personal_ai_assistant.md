---
id: task_00050_design_memory_architecture_for_personal_ai_assistant
name: Design Memory Architecture for Personal AI Assistant
category: Knowledge and Memory Management
grading_type: hybrid
timeout_seconds: 1800
workspace_files:
- source: requirements/project_brief.md
  dest: requirements/project_brief.md
- source: requirements/user_personas.yaml
  dest: requirements/user_personas.yaml
- source: existing_system/current_config.json
  dest: existing_system/current_config.json
- source: existing_system/sample_memories/2024-01-15_session.txt
  dest: existing_system/sample_memories/2024-01-15_session.txt
- source: research/cognitive_architecture_notes.md
  dest: research/cognitive_architecture_notes.md
- source: research/file_format_comparison.yaml
  dest: research/file_format_comparison.yaml
- source: research/indexing_benchmarks.json
  dest: research/indexing_benchmarks.json
- source: research/embedding_models_offline.md
  dest: research/embedding_models_offline.md
- source: config/distillation_schedule_draft.yaml
  dest: config/distillation_schedule_draft.yaml
- source: config/directory_template.txt
  dest: config/directory_template.txt
- source: logs/prototype_test_run.log
  dest: logs/prototype_test_run.log
- source: logs/storage_growth_simulation.csv
  dest: logs/storage_growth_simulation.csv
- source: vendor_docs/tantivy_quickstart.md
  dest: vendor_docs/tantivy_quickstart.md
- source: research/competitor_analysis.json
  dest: research/competitor_analysis.json
grading_weights:
  automated: 0.45
  llm_judge: 0.55
subcategory: Memory and Context Management
---
## Prompt

We've been building a personal AI assistant that's supposed to run entirely offline on a user's desktop, and the current memory system is... well, it's just a pile of text files in a folder. No metadata, no indexing, nothing. It was fine for prototyping but we're at the point where we need a real architecture.

I've dumped everything into this workspace — the project brief, user personas, our research on cognitive memory models, file format comparisons, indexing benchmarks, embedding model options, a draft distillation schedule someone put together, a directory layout sketch, growth simulations, competitor analysis, and even some prototype test logs. It's a lot, and honestly I haven't had time to cross-check everything for consistency, so please be careful with the numbers — some of this research was done by different people at different times and I wouldn't be surprised if there are errors or contradictions lurking in there.

What I need from you: synthesize all of this into a comprehensive memory architecture design document. The output should go into `memory_architecture_design.md` and should cover:

- The three-layer memory model (working, episodic, semantic) with concrete specs for each layer — file formats (with example metadata schemas), storage structure, retention policies with explicit numeric thresholds, capacity limits, and eviction/promotion triggers
- A file/directory organization scheme that can scale to our storage budget, with enough detail to be directly implementable
- Search and retrieval strategy covering both full-text and semantic search, with specific technology recommendations, justification based on the benchmarks and constraints, and explicit latency budget allocation across the layers
- The distillation pipeline — how memories flow from working → episodic → semantic, triggers, scheduling, what gets kept vs. discarded, and minimum-mention thresholds for promotion
- An embedding model recommendation for the semantic layer with rationale tied to local-first constraints (model size, dimensionality, CPU inference speed), with a standardized embedding dimension to avoid the dimension drift issues visible in the prototype
- A storage growth projection showing we stay within budget across **all three personas** (researcher, project manager, creative writer) over at least 24 months, with per-persona calculations
- Lessons learned from the prototype test logs (`logs/prototype_test_run.log`) — what systemic issues does the log reveal, and how does the proposed architecture address them?
- Any inconsistencies or data quality issues you find in the workspace files — call these out explicitly rather than silently picking one version

The design needs to satisfy all three user personas and respect every constraint in the project brief. Don't just summarize the input files — I need actual architectural decisions with reasoning. If two sources disagree, figure out which one is right and explain why.

## Expected Behavior

The agent must produce a comprehensive architecture design document at `memory_architecture_design.md` that synthesizes information from all workspace files while critically evaluating the data for errors and contradictions.

### Trap 1: SQLite FTS5 Index Size Error (research/indexing_benchmarks.json)
The `research/indexing_benchmarks.json` file reports SQLite FTS5's `index_size_mb` as 45 MB for 10,000 documents averaging 2KB each (total corpus ~20MB). This is a decimal point error — the correct value should be approximately 4.5 MB. The agent should recognize that a 45 MB index for a 20 MB corpus is implausible (225% overhead) compared to other engines in the same benchmark (e.g., tantivy at a few MB). The agent should flag this as a likely data error and not use the inflated figure to dismiss SQLite FTS5 on storage grounds. If the agent blindly adopts the 45 MB figure and uses it to argue against SQLite FTS5, that is incorrect.

### Trap 2: Episodic Retention Days Contradiction (config/distillation_schedule_draft.yaml vs. requirements/project_brief.md and requirements/user_personas.yaml)
The `config/distillation_schedule_draft.yaml` sets `episodic_retention_days: 30`. However, `requirements/project_brief.md` explicitly requires at least 180 days for the researcher persona, and `requirements/user_personas.yaml` additionally shows the creative writer persona has `typical_search_depth_days: 365` with a requirement that "ideas from a year ago may become relevant." To satisfy all three personas the correct episodic retention should be at least 365 days. The draft config's 30-day retention would destroy critical episodic memories for both the researcher (180-day need) and the creative writer (365-day need). The agent should identify this contradiction, side with the persona requirements, and recommend an episodic retention period of at least 365 days (or at minimum 180 days with explicit acknowledgment that the writer persona's year-long access is unmet at that threshold). The agent should explicitly flag the draft config as incorrect.

### Trap 3: Unit Mismatch in Competitor Analysis (research/competitor_analysis.json)
In `research/competitor_analysis.json`, one competitor entry (LocalMind) reports storage efficiency as "0.85 GB per 1000 entries" while all other entries in the same dataset use MB as the unit. This is a unit error — it should be 0.85 MB per 1000 entries, which would actually make LocalMind the most storage-efficient system listed. The agent should notice the unit inconsistency and flag it rather than taking the GB figure at face value (which would make LocalMind appear ~1000x less efficient than it actually is).

### Trap 4: SQLite Lock Timeouts in Prototype Log (logs/prototype_test_run.log)
The prototype test log contains multiple `SQLite lock timeout exceeded — switching to flat files` errors. A naive agent might use these errors to conclude that SQLite (and by extension SQLite FTS5) is unreliable and should be avoided. This would be incorrect. The lock timeouts are caused by the prototype's ad-hoc, multi-threaded custom implementation that opened concurrent write connections without proper WAL mode configuration — not by SQLite FTS5's search functionality itself. SQLite FTS5 used correctly (WAL journal mode, single-writer model, connection pooling) would not exhibit these lock issues. Additionally, the prototype log shows embedding dimension mismatches (`expected 384, got 256` and `expected 384, got 512`), revealing that the prototype used inconsistent embedding models. The new architecture must standardize on a single embedding dimension. The agent should extract these concrete lessons from the log and address them in the design, rather than either ignoring the log entirely or drawing incorrect conclusions from it.

### Core Architecture Decisions Expected
- **File format**: Should recommend Markdown with YAML frontmatter based on the file format comparison (highest combined score for human readability + metadata support), which aligns with the local-first, file-based constraints.
- **Search**: Should recommend tantivy or SQLite FTS5 for full-text search (both meet the <500ms working memory and <2s semantic search latency requirements). Should not dismiss SQLite FTS5 based on the erroneous 45MB index size.
- **Embedding model**: Should recommend one of the surveyed models (likely all-MiniLM-L6-v2 or GTE-small for their small size and good CPU inference speed), justified by the local-first constraint and model size considerations from `research/embedding_models_offline.md`.
- **Directory structure**: Should propose a hierarchical structure informed by `config/directory_template.txt` and the three-layer model from `research/cognitive_architecture_notes.md`.
- **Distillation**: Should define a pipeline with corrected retention policies (not the 30-day draft), appropriate triggers, and a consolidation process that moves episodic memories to semantic abstractions.
- **Storage projection**: Should reference `logs/storage_growth_simulation.csv` and validate against the 10GB budget across all personas over 24 months.

## Grading Criteria

- [ ] Output file `memory_architecture_design.md` exists and is a well-structured Markdown document with clear sections and headings
- [ ] Defines all three memory layers (working, episodic, semantic) with concrete specifications including file format, capacity limits, and retention policies
- [ ] Recommends a specific file format with justification referencing the file format comparison data
- [ ] Proposes a directory/file organization scheme that supports the three-layer model and scales to 10GB
- [ ] Provides search and retrieval strategy covering both full-text and semantic search with specific technology recommendations
- [ ] Recommends a specific offline embedding model with rationale tied to local-first constraints (model size, CPU inference speed)
- [ ] Defines the distillation pipeline with triggers, scheduling, and consolidation logic for working → episodic → semantic flow
- [ ] Describes the daily logging workflow for automatically capturing interactions as episodic memory entries
- [ ] Describes a cross-reference or linking mechanism connecting related memory entries across layers or sessions
- [ ] Includes a storage growth projection referencing the simulation data and validating against the 10GB budget for at least 24 months
- [ ] Identifies the SQLite FTS5 index size error in indexing_benchmarks.json (45 MB should be ~4.5 MB) and does not use the inflated figure to dismiss SQLite FTS5
- [ ] Identifies the episodic retention contradiction between distillation_schedule_draft.yaml (30 days) and the project brief/personas (needs ≥180 days) and recommends a corrected retention period
- [ ] Identifies the unit mismatch in competitor_analysis.json (LocalMind listed as 0.85 GB instead of 0.85 MB per 1000 entries)
- [ ] Architecture decisions satisfy all three user personas described in user_personas.yaml (researcher, project manager, creative writer), with per-persona storage calculations in the growth projection
- [ ] All recommendations respect the core constraints: local-first, offline, file-based (no database servers), single-user desktop, <500ms working memory retrieval, <2s semantic search
- [ ] Identifies at least one concrete lesson from the prototype test logs (lock timeouts or embedding dimension mismatches) and explains how the proposed architecture resolves it
- [ ] Does not incorrectly dismiss SQLite FTS5 based on the SQLite lock timeout errors in the prototype log (correctly attributes lock issues to implementation, not to SQLite FTS5 itself)
- [ ] Document contains original architectural reasoning and trade-off analysis, not merely summaries of input files

## Automated Checks

```python
import os
import re
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the memory_architecture_design.md output file."""
    
    results = {
        "output_file_exists": 0.0,
        "three_layer_architecture": 0.0,
        "directory_structure_section": 0.0,
        "file_format_specification": 0.0,
        "daily_logging_workflow": 0.0,
        "distillation_workflow": 0.0,
        "retrieval_search_section": 0.0,
        "episodic_retention_correct": 0.0,
        "retention_adequate": 0.0,
        "embedding_model_mentioned": 0.0,
        "indexing_solution_proposed": 0.0,
        "storage_budget_awareness": 0.0,
        "cross_reference_mechanism": 0.0,
        "identifies_fts5_error": 0.0,
        "identifies_localmind_unit_error": 0.0,
        "persona_requirements_addressed": 0.0,
        "prototype_log_analyzed": 0.0,
    }
    
    # Check if output file exists
    output_path = os.path.join(workspace_path, "memory_architecture_design.md")
    if not os.path.isfile(output_path):
        return results
    
    results["output_file_exists"] = 1.0
    
    # Read file content
    with open(output_path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    
    # For regex_match checks that use re.DOTALL, we need the full content
    content_lower = content.lower()
    
    # --- three_layer_architecture ---
    # regex_match: (?i)(working\s+memory|working\s+layer).*?(episodic\s+memory|episodic\s+layer).*?(semantic\s+memory|semantic\s+layer)
    # Need re.DOTALL so .* matches across lines
    pattern_three_layer = r"(?i)(working\s+memory|working\s+layer).*?(episodic\s+memory|episodic\s+layer).*?(semantic\s+memory|semantic\s+layer)"
    if re.search(pattern_three_layer, content, re.DOTALL):
        results["three_layer_architecture"] = 1.0
    
    # --- directory_structure_section ---
    # section_exists: "Directory Structure"
    # Check for markdown heading containing "Directory Structure" (case-insensitive)
    pattern_dir_section = r"(?im)^#{1,6}\s+.*Directory\s+Structure"
    if re.search(pattern_dir_section, content):
        results["directory_structure_section"] = 1.0
    
    # --- file_format_specification ---
    # content_contains: "frontmatter"
    # Check that "frontmatter" appears in a meaningful context (near words like YAML, markdown, format, metadata)
    # Use word boundary to avoid substring matches
    pattern_frontmatter = r"(?i)\bfrontmatter\b"
    if re.search(pattern_frontmatter, content):
        results["file_format_specification"] = 1.0
    
    # --- daily_logging_workflow ---
    # content_near: "daily|logging"
    # Both "daily" and "logging" must appear in the same paragraph
    paragraphs = re.split(r"\n\s*\n", content)
    for para in paragraphs:
        para_lower = para.lower()
        if re.search(r"\bdaily\b", para_lower) and re.search(r"\blogging\b", para_lower):
            results["daily_logging_workflow"] = 1.0
            break
    
    # --- distillation_workflow ---
    # content_near: "distillation|semantic"
    # Both "distillation" and "semantic" must appear in the same paragraph
    for para in paragraphs:
        para_lower = para.lower()
        if re.search(r"\bdistillation\b", para_lower) and re.search(r"\bsemantic\b", para_lower):
            results["distillation_workflow"] = 1.0
            break
    
    # --- retrieval_search_section ---
    # section_exists: "Search"
    # Check for markdown heading containing "Search" (case-insensitive)
    pattern_search_section = r"(?im)^#{1,6}\s+.*Search"
    if re.search(pattern_search_section, content):
        results["retrieval_search_section"] = 1.0
    
    # --- episodic_retention_correct ---
    # absence_check: "episodic_retention_days: 30"
    # Score 1.0 if the forbidden string is NOT present (case-insensitive)
    forbidden = "episodic_retention_days: 30"
    if forbidden.lower() not in content_lower:
        results["episodic_retention_correct"] = 1.0
    
    # --- retention_adequate ---
    # regex_match: (?i)(1[8-9]\d|[2-9]\d{2}|\d{4,})\s*(day|d\b)
    # Matches numbers >= 180 followed by "day" or "d" (word boundary)
    pattern_retention = r"(?i)(1[8-9]\d|[2-9]\d{2}|\d{4,})\s*(day|d\b)"
    if re.search(pattern_retention, content):
        results["retention_adequate"] = 1.0
    
    # --- embedding_model_mentioned ---
    # regex_match: (?i)(miniLM|nomic.embed|bge.small|gte.small|embedding\s+model|sentence.transformer)
    pattern_embedding = r"(?i)(miniLM|nomic.embed|bge.small|gte.small|embedding\s+model|sentence.transformer)"
    if re.search(pattern_embedding, content):
        results["embedding_model_mentioned"] = 1.0
    
    # --- indexing_solution_proposed ---
    # regex_match: (?i)(tantivy|sqlite\s*fts|fts5|whoosh|inverted\s+index|full.text\s+search)
    pattern_indexing = r"(?i)(tantivy|sqlite\s*fts|fts5|whoosh|inverted\s+index|full.text\s+search)"
    if re.search(pattern_indexing, content):
        results["indexing_solution_proposed"] = 1.0
    
    # --- storage_budget_awareness ---
    # regex_match: (?i)(10\s*GB|storage\s+(budget|limit|constraint|growth))
    pattern_storage = r"(?i)(10\s*GB|storage\s+(budget|limit|constraint|growth))"
    if re.search(pattern_storage, content):
        results["storage_budget_awareness"] = 1.0
    
    # --- cross_reference_mechanism ---
    # content_near: "cross-reference|link"
    # Both "cross-reference" and "link" must appear in the same paragraph
    for para in paragraphs:
        para_lower = para.lower()
        if re.search(r"cross-reference", para_lower) and re.search(r"\blink", para_lower):
            results["cross_reference_mechanism"] = 1.0
            break
    
    # --- identifies_fts5_error ---
    # Agent should flag the 45MB index_size_mb as a decimal error (~4.5 MB is correct)
    if (content_near("fts5", "4.5", content_lower) or
            content_near("sqlite", "4.5", content_lower) or
            content_near("fts5", "error", content_lower) or
            content_near("fts5", "incorrect", content_lower) or
            content_near("fts5", "decimal", content_lower)):
        results["identifies_fts5_error"] = 1.0

    # --- identifies_localmind_unit_error ---
    # Agent should flag that LocalMind's "0.85 GB per 1000 entries" is a unit error (should be MB)
    if (content_near("localmind", "unit", content_lower) or
            content_near("localmind", "gb", content_lower) or
            content_near("localmind", "mismatch", content_lower) or
            content_near("localmind", "error", content_lower) or
            content_near("localmind", "mb", content_lower)):
        results["identifies_localmind_unit_error"] = 1.0

    # --- persona_requirements_addressed ---
    # All three user personas must be referenced explicitly
    has_researcher = bool(re.search(r'(?i)\bresearch(er)?\b', content))
    has_pm = bool(re.search(r'(?i)(project.?manager|project.?management\b)', content))
    has_writer = bool(re.search(r'(?i)(creative.?writer|writer\b)', content))
    persona_count = sum([has_researcher, has_pm, has_writer])
    if persona_count == 3:
        results["persona_requirements_addressed"] = 1.0
    elif persona_count == 2:
        results["persona_requirements_addressed"] = 0.5

    # --- prototype_log_analyzed ---
    # Agent should note issues from the prototype test log:
    # SQLite lock timeouts (correctly attributed to prototype implementation, not FTS5 itself)
    # and/or embedding dimension mismatches (384 vs 256 vs 512 in the log)
    has_lock_timeout = bool(re.search(r'(?i)(lock.?timeout|lock\s+timeout|sqlite.{0,40}lock)', content))
    has_embed_mismatch = bool(re.search(
        r'(?i)(dimension.{0,40}mismatch|embedding.{0,40}(256|512)|mismatch.{0,40}dimension)',
        content, re.DOTALL
    ))
    if has_lock_timeout or has_embed_mismatch:
        results["prototype_log_analyzed"] = 1.0

    return results


def content_near(term1: str, term2: str, text: str, window: int = 300) -> bool:
    """Return True if term1 and term2 appear within `window` characters of each other in text."""
    positions1 = [m.start() for m in re.finditer(re.escape(term1), text)]
    positions2 = [m.start() for m in re.finditer(re.escape(term2), text)]
    for p1 in positions1:
        for p2 in positions2:
            if abs(p1 - p2) <= window:
                return True
    return False
```

## LLM Judge Rubric

### Criterion 1: Detection and Resolution of Data Contradictions and Traps (Weight: 40%)
**Score 1.0**: The document explicitly identifies and correctly resolves all four traps: (1) flags the SQLite FTS5 45MB index size as a likely decimal point error (~4.5MB is correct), does not use the inflated figure to dismiss FTS5, and provides corrected reasoning; (2) explicitly calls out the 30-day episodic retention in the distillation schedule draft as contradicting the project brief and persona requirements, recommending at least 365 days with clear justification; (3) identifies the unit mismatch (MB vs GB) in the competitor analysis for LocalMind and corrects it; (4) extracts concrete lessons from the prototype test log — notes that the SQLite lock timeouts are implementation-level issues (not FTS5's fault), and that embedding dimension inconsistency (384/256/512 mismatches) must be resolved by standardizing the embedding model. Each contradiction is surfaced with specific file references and reasoning.
**Score 0.75**: The document correctly identifies and resolves three of the four traps with explicit callouts, and partially addresses the fourth.
**Score 0.5**: The document correctly identifies and resolves two of the four traps explicitly, and may implicitly avoid the consequences of the others.
**Score 0.25**: The document does not explicitly flag any contradictions but happens to avoid the worst consequences of one or two traps (e.g., recommends reasonable retention or doesn't dismiss FTS5, but without demonstrating critical analysis of the source data).
**Score 0.0**: The document blindly adopts erroneous data from the workspace files — uses the 45MB FTS5 figure to argue against it, accepts 30-day retention without question, treats LocalMind as storage-inefficient based on the unit mismatch, or uses the prototype log's SQLite errors to dismiss SQLite FTS5 — showing no critical evaluation of source data consistency.

### Criterion 2: Depth and Rigor of Technical Architecture Specifications (Weight: 35%)
**Score 1.0**: Each of the three memory layers (working, episodic, semantic) is specified with concrete, well-justified technical details including precise file formats with example metadata schemas, storage structures with capacity calculations tied to the 10GB budget and per-persona growth simulations, retention/eviction policies with explicit numeric thresholds grounded in persona requirements (e.g., "≥365 days episodic retention to satisfy the creative writer's year-long search depth"), and clear transition rules between layers. The search and retrieval strategy provides specific technology selections (e.g., named embedding models with dimensionality explicitly stated, indexing engine with latency budget justification) with trade-off analysis grounded in the benchmark data. The directory structure is detailed enough to be directly implementable. Prototype log lessons are addressed in the design (e.g., WAL mode for SQLite, standardized embedding dimension).
**Score 0.75**: All three layers are specified with concrete technical details and most recommendations are well-justified with references to workspace data. Minor gaps exist — e.g., capacity calculations are approximate rather than precise, or one layer's eviction policy lacks full justification — but the overall design is implementable and internally consistent.
**Score 0.5**: The three layers are defined with some technical specifics, but the document is uneven — some layers have detailed specs while others remain vague or generic. Technology recommendations are made but justifications are thin or not clearly tied to the benchmark/research data. The design would require significant additional specification before implementation.
**Score 0.25**: The document provides a high-level overview of the three-layer model but lacks concrete specifications for most aspects. Technology choices are mentioned without meaningful justification. The architecture reads more like a conceptual outline than a design document.
**Score 0.0**: The document is superficial, providing only generic descriptions of memory layers without concrete file formats, capacity limits, retention policies, or justified technology selections. No meaningful synthesis of the workspace research data is evident.

### Criterion 3: Coherence, Synthesis Quality, and Professional Document Structure (Weight: 25%)
**Score 1.0**: The document reads as a unified, professionally structured architecture design — not a collection of summaries of individual files. Information from multiple workspace sources (personas, benchmarks, growth simulations, competitor analysis, prototype logs) is woven together into coherent arguments. The document has logical flow with clear section organization, uses cross-references between its own sections (e.g., retention policy references persona needs, storage calculations reference growth simulations), and presents a design where all components work together as a system. Assumptions are stated, trade-offs are acknowledged, and the rationale chain from requirements through analysis to design decisions is traceable.
**Score 0.75**: The document is well-structured and mostly reads as a coherent design. Most sections synthesize multiple sources effectively. Minor issues such as occasional redundancy, a section that feels disconnected, or a few design decisions that aren't fully traced back to requirements.
**Score 0.5**: The document has reasonable structure but reads partly as a synthesis and partly as summaries of individual workspace files. Some design decisions feel disconnected from the stated requirements or data. The overall narrative holds together but lacks polish and tight integration between sections.
**Score 0.25**: The document is loosely organized with significant coherence issues — sections may contradict each other, design decisions appear arbitrary, or the document reads primarily as a file-by-file summary rather than an integrated design. Limited evidence of cross-source synthesis.
**Score 0.0**: The document is disorganized, internally contradictory, or largely incoherent. It fails to synthesize workspace materials into a unified design and may contain significant hallucinated content not grounded in the provided data.