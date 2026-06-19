---
id: task_00024_create_skill_md_for_docx_reader_openclaw_skill
name: Create SKILL.md for docx-reader OpenClaw Skill
category: Workflow and Agent Orchestration
grading_type: hybrid
timeout_seconds: 1800
workspace_files:
- source: skills/docx-reader/convert_docx.py
  dest: skills/docx-reader/convert_docx.py
- source: skills/docx-reader/requirements.txt
  dest: skills/docx-reader/requirements.txt
- source: skills/docx-reader/developer-notes.txt
  dest: skills/docx-reader/developer-notes.txt
- source: docs/openclaw-skill-spec.md
  dest: docs/openclaw-skill-spec.md
- source: docs/openclaw-skill-spec-v2-draft.md
  dest: docs/openclaw-skill-spec-v2-draft.md
- source: docs/team-decisions.md
  dest: docs/team-decisions.md
- source: config/openclaw.yaml
  dest: config/openclaw.yaml
- source: skills/csv-reader/SKILL.md
  dest: skills/csv-reader/SKILL.md
- source: skills/docx-reader/sample_input.docx
  dest: skills/docx-reader/sample_input.docx
- source: logs/agent-run-2024-06-15.log
  dest: logs/agent-run-2024-06-15.log
- source: docs/python-docx-notes.md
  dest: docs/python-docx-notes.md
- source: config/deps.yaml
  dest: config/deps.yaml
grading_weights:
  automated: 0.75
  llm_judge: 0.25
subcategory: Agent and AI Orchestration
---
## Prompt

So we're onboarding a new `docx-reader` skill into our OpenClaw agent framework, and I need the `SKILL.md` file written for it. There's already a working example under `skills/csv-reader/SKILL.md` that you can use as a reference for the format, and the official skill specification lives somewhere in the `docs/` folder — there are a few docs in there, so make sure you figure out which one is actually operative for our current production environment.

The skill itself is in `skills/docx-reader/` — there's a Python script (`convert_docx.py`) that converts `.docx` files to plain text, along with a `requirements.txt` and some developer notes. Take a look at those to understand what the skill does, what its dependencies are, and how it's invoked. Check the actual script carefully, not just the notes — implementation and documentation don't always agree.

I also know there are some team decision documents and internal notes floating around about this skill. You may want to cross-reference them, but be careful — not everything that's been discussed or planned is actually deployed yet. The system config is the ground truth for what's currently running.

Also, if you notice anything wrong with the existing `convert_docx.py` script (logic issues, incomplete features, missing error handling, etc.), please mention the issues briefly in the SKILL.md — maybe in a "Known Issues" or "Notes" section at the bottom. Be specific: vague statements like "error handling could be improved" are not useful; point to the exact problem in the code.

Write the output to `skills/docx-reader/SKILL.md`. Thanks!

## Expected Behavior

The agent should produce a well-structured `SKILL.md` file at `skills/docx-reader/SKILL.md` that conforms to the **official v1 OpenClaw Skill Specification** found in `docs/openclaw-skill-spec.md`.

### Correct Spec to Follow
The agent must use `docs/openclaw-skill-spec.md` (v1, official) as the authoritative specification. This requires the following sections in SKILL.md: **name**, **description**, **version**, **author**, **dependencies**, **usage**, **inputs**, **outputs**, and a declared **runtime**. The authoritative indicator of which spec version is currently operative is `config/openclaw.yaml`, which reads `spec_version: 1`.

**Trap 1 — Draft v2 Spec (`docs/openclaw-skill-spec-v2-draft.md`):** This file is in the same `docs/` directory and looks authoritative, but it is clearly marked as a DRAFT. It contradicts the official spec by requiring a "permissions" section and claiming dependencies should be declared in a `deps.yaml` file instead of `requirements.txt`. The agent should recognize this is a draft and **not** follow it. The SKILL.md should reference `requirements.txt` (not `deps.yaml`) as the dependency file, and should **not** include a "permissions" section as if it were required. The file `config/deps.yaml` exists in the workspace but should be ignored or at most noted as irrelevant under the current spec.

**Trap 2 — Outdated python-docx notes (`docs/python-docx-notes.md`):** This file contains the incorrect installation command `pip install docx` (which installs a completely different, legacy package). The correct PyPI package is `python-docx`, as correctly listed in `skills/docx-reader/requirements.txt`. The agent should reference `python-docx` (not `docx`) as the dependency in the SKILL.md. If the agent mentions installation, it should say `pip install python-docx`, not `pip install docx`. The file also contains the outdated API pattern `docx.opendocx(path)` which is from the legacy package — the agent should not propagate this.

**Trap 3 — ADR-031 Team Decision Document (`docs/team-decisions.md`):** This file contains ADR-031, which appears to officially mandate that `docx-reader` use the v2 spec format — specifically requiring a `permissions` section (`filesystem:read`, `filesystem:write`) and `deps.yaml` instead of `requirements.txt`. The document looks authoritative (marked "Accepted and Merged, PR #892"). However, the correct resolution is: ADR-031 describes a planned pilot that has NOT yet been operationalized. The production agent config (`config/openclaw.yaml`) still reads `spec_version: 1`, and the v2 spec is still labeled "DRAFT." The agent must follow the current operative state (v1 spec), not a forward-looking planning document. The SKILL.md must NOT add a mandatory `permissions` section, and must use `requirements.txt` as the canonical dependency file.

**Trap 4 — Fake Output File Support (`skills/docx-reader/developer-notes.txt` + `convert_docx.py`):** The file `skills/docx-reader/developer-notes.txt` claims that version `0.1.1` added optional output path support via a second argument (`python convert_docx.py input.docx output.txt`). Correspondingly, `convert_docx.py` does parse `output_path = sys.argv[2] if len(sys.argv) >= 3 else None`. However, this variable is **never actually used** — the script always calls `print(result)` regardless of whether an output path was provided. This is dead code. The agent must read the actual script rather than trusting the developer notes, and correctly identify this as a bug in the Known Issues section. The usage in the SKILL.md should reflect the script's real behavior (stdin/stdout only, not file writing). The agent must NOT write the usage section as `python convert_docx.py input.docx output.txt` as if that feature works.

### Script Analysis
The agent should review `skills/docx-reader/convert_docx.py` and identify its real issues:
1. **output_path is dead code**: The script assigns `output_path = sys.argv[2] if len(sys.argv) >= 3 else None`, which suggests output file writing. However, `output_path` is never used — the script always calls `print(result)`. Despite what `developer-notes.txt` says, the script cannot write to an output file as written.
2. **Missing try/except error handling**: The script has no exception handling for missing files, invalid formats, or insufficient command-line arguments. A TODO comment flags this (`# TODO: add error handling for missing file or invalid format`).
3. **No sys.argv bounds check**: The script will raise `IndexError` with no helpful message if invoked without any arguments.

Note: `import docx` followed by `docx.Document(path)` is syntactically valid with `python-docx` installed (the installed module IS named `docx`), so this is not a definitive bug — it is a stylistic note that `from docx import Document` is the more idiomatic pattern.

These issues should be documented in the SKILL.md in a "Known Issues" or "Notes" section.

### Content Expectations
- **Name:** `docx-reader`
- **Description:** Converts .docx files to plain text using python-docx
- **Version:** Something reasonable (e.g., `0.1.0` or `1.0.0`)
- **Runtime:** `python3` (consistent with `config/openclaw.yaml`)
- **Dependencies:** `python-docx` (referencing `requirements.txt`, NOT `deps.yaml`)
- **Usage:** `python convert_docx.py input.docx` — single argument only (output_path is dead code)
- **Inputs:** A `.docx` file path
- **Outputs:** Plain text printed to stdout (the script does NOT write a .txt file)
- **Notes/Known Issues:** Identifies the dead output_path code and missing error handling

The agent should use `skills/csv-reader/SKILL.md` as a structural reference for formatting.

## Grading Criteria

- [ ] The file `skills/docx-reader/SKILL.md` exists and is valid Markdown
- [ ] The SKILL.md contains all required sections from the official v1 spec: name, description, version, author, runtime, dependencies, usage, inputs, outputs
- [ ] The skill name is `docx-reader`
- [ ] The runtime is declared as `python3`
- [ ] Dependencies reference `python-docx` (not `docx`) and mention `requirements.txt` (not `deps.yaml`)
- [ ] The SKILL.md does NOT treat "permissions" as a required section (correctly rejects both the draft v2 spec and ADR-031, which is not yet operative)
- [ ] The usage section accurately reflects single-argument invocation (`python convert_docx.py input.docx`) and does NOT present the two-argument form as functional
- [ ] Inputs are described as a .docx file path; outputs accurately note the script prints to stdout (not writes a .txt file)
- [ ] The SKILL.md includes a notes or known issues section identifying: (1) the `output_path` variable is parsed but never used — the script always prints to stdout despite appearances, and (2) missing error handling
- [ ] The overall document structure is consistent with the format shown in `skills/csv-reader/SKILL.md`
- [ ] The SKILL.md does not propagate incorrect information from `docs/python-docx-notes.md` (no `pip install docx`, no `docx.opendocx()` pattern)
- [ ] The Known Issues section is specific and code-grounded, not generic (e.g., references actual variable names or line-level behavior)

## Automated Checks

```python
import os
import re
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the SKILL.md file produced by the agent."""

    output_file = os.path.join(workspace_path, "skills", "docx-reader", "SKILL.md")

    # All keys with default 0.0
    result = {
        "output_file_exists": 0.0,
        "skill_name_present": 0.0,
        "description_section": 0.0,
        "dependencies_section": 0.0,
        "usage_section": 0.0,
        "inputs_section": 0.0,
        "outputs_section": 0.0,
        "correct_install_command": 0.0,
        "no_wrong_install": 0.0,
        "python_docx_import": 0.0,
        "stdout_output_described": 0.0,
        "runtime_declared": 0.0,
        "requirements_txt_referenced": 0.0,
        "no_deps_yaml_recommendation": 0.0,
        "code_block_present": 0.0,
        "known_issues_section": 0.0,
        "no_required_permissions_from_adr": 0.0,
        "identifies_dead_output_code": 0.0,
        "author_field_present": 0.0,
    }

    # Check file existence
    if not os.path.isfile(output_file):
        return result

    result["output_file_exists"] = 1.0

    # Read file content
    with open(output_file, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    content_lower = content.lower()

    # --- skill_name_present ---
    if re.search(r'docx-reader', content):
        result["skill_name_present"] = 1.0

    # --- description_section ---
    if re.search(r'(?i)##?\s*description', content):
        result["description_section"] = 1.0

    # --- dependencies_section ---
    if re.search(r'(?i)##?\s*dependencies', content):
        result["dependencies_section"] = 1.0

    # --- usage_section ---
    if re.search(r'(?i)##?\s*usage', content):
        result["usage_section"] = 1.0

    # --- inputs_section ---
    if re.search(r'(?i)##?\s*inputs?', content):
        result["inputs_section"] = 1.0

    # --- outputs_section ---
    if re.search(r'(?i)##?\s*outputs?', content):
        result["outputs_section"] = 1.0

    # --- correct_install_command ---
    if re.search(r'pip\s+install\s+python-docx', content):
        result["correct_install_command"] = 1.0

    # --- no_wrong_install ---
    # Penalize if "pip install docx" appears where docx is NOT followed by a hyphen
    if re.search(r'pip\s+install\s+docx(?:[^-\w]|$)', content):
        result["no_wrong_install"] = 0.0
    else:
        result["no_wrong_install"] = 1.0

    # --- python_docx_import ---
    if re.search(r'(?i)(from\s+docx\s+import\s+Document|import\s+docx)', content):
        result["python_docx_import"] = 1.0

    # --- stdout_output_described ---
    # Check that the agent correctly describes output as stdout (not as writing a .txt file).
    # Accept: "stdout", "standard output", "prints to", "print", "console output".
    # Penalize: agent claims the script writes to a .txt file without qualification.
    stdout_ok = re.search(r'(?i)(stdout|standard\s+output|print(s)?\s+to|console\s+output)', content)
    claims_writes_txt = re.search(
        r'(?i)(write[sd]?\s+.{0,30}\.txt|output\s+.{0,20}\.txt\s+(file|path)|\.txt\s+file\s+(is\s+)?written)',
        content
    )
    if stdout_ok and not claims_writes_txt:
        result["stdout_output_described"] = 1.0
    elif stdout_ok and claims_writes_txt:
        result["stdout_output_described"] = 0.5
    else:
        result["stdout_output_described"] = 0.0

    # --- runtime_declared ---
    if re.search(r'\bpython3\b', content):
        result["runtime_declared"] = 1.0

    # --- requirements_txt_referenced ---
    if re.search(r'requirements\.txt', content):
        result["requirements_txt_referenced"] = 1.0

    # --- no_deps_yaml_recommendation ---
    # Score 1.0 if deps.yaml absent, OR if mentioned alongside requirements.txt as contrast.
    if 'deps.yaml' not in content_lower:
        result["no_deps_yaml_recommendation"] = 1.0
    elif re.search(r'requirements\.txt', content):
        result["no_deps_yaml_recommendation"] = 1.0

    # --- code_block_present ---
    if re.search(r'```(?:python|bash|sh|shell)[\s\S]*?```', content):
        result["code_block_present"] = 1.0

    # --- known_issues_section ---
    if re.search(r'(?i)##?\s*(known[\s_-]?issues?|notes?)', content):
        result["known_issues_section"] = 1.0

    # --- no_required_permissions_from_adr ---
    # ADR-031 trap: agent should NOT treat "permissions" as a required section.
    # Score 1.0 if no permissions heading exists.
    # Score 0.75 if permissions is mentioned but clearly labelled as optional/v2/draft-only.
    # Score 0.0 if a mandatory permissions section is included.
    if not re.search(r'(?i)##?\s*permissions', content):
        result["no_required_permissions_from_adr"] = 1.0
    elif re.search(r'(?i)(optional|v2|draft|not\s+required|n/a|not\s+applicable)', content):
        result["no_required_permissions_from_adr"] = 0.75
    else:
        result["no_required_permissions_from_adr"] = 0.0

    # --- identifies_dead_output_code ---
    # Trap 4: agent should identify that output_path is parsed but never used.
    # Correct Known Issues note refers to: the variable being assigned but unused,
    # or that despite appearing to accept an output argument, the script always prints to stdout.
    if re.search(
        r'(?i)(output_path.{0,300}(never\s+used|not\s+used|unused|dead|never\s+writ|not\s+writ)|'
        r'(never\s+used|unused|dead\s+code|not\s+used).{0,300}output_path|'
        r'output.{0,20}path.{0,200}assign.{0,100}(never|not).{0,50}(used|writ)|'
        r'second\s+arg.{0,200}(never|not\s+used|ignored|no\s+effect))',
        content, re.DOTALL
    ):
        result["identifies_dead_output_code"] = 1.0

    # Check for required v1 metadata fields
    if "author:" in content_lower or "author :" in content_lower:
        result["author_field_present"] = 1.0
    else:
        result["author_field_present"] = 0.0

    return result
```

## LLM Judge Rubric

### Criterion 1: Trap Detection and Reasoning Quality (Weight: 45%)
**Score 1.0**: The agent correctly handles all four traps with explicit, well-reasoned explanations. (1) Rejects the v2 draft spec as DRAFT; (2) rejects `docs/python-docx-notes.md` legacy API/install command, citing `requirements.txt` as correct; (3) rejects ADR-031 because `config/openclaw.yaml` shows `spec_version: 1` — the ADR describes an undeployed pilot; (4) identifies that `output_path` in `convert_docx.py` is dead code — parsed from sys.argv[2] but never used, contradicting `developer-notes.txt`. The SKILL.md is free of all trap residue. The agent demonstrates systematic cross-referencing of the system config as ground truth.
**Score 0.75**: The agent correctly handles at least three of the four traps and produces a largely correct SKILL.md. One trap is either missed or handled without explicit reasoning. For example, the agent avoids `deps.yaml` and wrong install commands but adds a `permissions` section without questioning ADR-031, or it correctly describes stdout output but doesn't call out `output_path` as dead code.
**Score 0.5**: The agent correctly handles two traps. Common pattern: correctly uses `requirements.txt` and rejects the wrong install command (trap 2), but follows ADR-031 by adding a permissions section (trap 3 failed) and doesn't identify the dead output_path code (trap 4 failed). The output has identifiable incorrect content traceable to unrecognized traps.
**Score 0.25**: The agent handles only one trap correctly. Most conflicting information is accepted uncritically. For example, uses `requirements.txt` but otherwise follows the v2 draft, includes `pip install docx`, and describes the usage as two-argument without noting the output_path bug.
**Score 0.0**: The agent falls for all or nearly all traps: uses `deps.yaml`, includes required permissions section, propagates `pip install docx` or `opendocx()`, and describes the output_path feature as working. No critical cross-referencing of authoritative sources is demonstrated.

### Criterion 2: Script Analysis and Known Issues Section (Weight: 35%)
**Score 1.0**: The SKILL.md includes a clearly labeled "Known Issues" or "Notes" section with specific, code-grounded analysis: (1) `output_path` is assigned from `sys.argv[2]` but the variable is never used — the script always prints to stdout regardless of whether an output argument is provided; (2) no try/except error handling — the script will crash ungracefully on missing files or bad arguments; (3) optionally: no sys.argv bounds check causing IndexError with no informative message. Issues are stated concretely and tied to specific code behavior, not generic observations.
**Score 0.75**: At least one of the two primary issues (dead output_path code or missing error handling) is correctly and specifically identified. The section may omit one issue, or address both but with slightly vague language. The key test: does the agent flag that `output_path` is never actually used to write a file?
**Score 0.5**: A Known Issues/Notes section exists but addresses issues generically (e.g., "error handling could be improved," "output writing not fully implemented") without referencing the actual code structure. The agent shows awareness that something is wrong but can't point to the specific dead-code pattern.
**Score 0.25**: The section exists but contains only vague, inaccurate, or misleading claims. For example, it flags the import style as a critical bug while completely missing the unused `output_path`, or describes a feature as working when the code shows it cannot.
**Score 0.0**: No Known Issues or Notes section is present, or the section is present but contains no genuine analysis of the script's actual deficiencies.

### Criterion 3: Document Structure, Completeness, and Professional Quality (Weight: 20%)
**Score 1.0**: The SKILL.md reads as a polished, production-ready skill document. It follows the v1 spec structure faithfully, uses clear and consistent Markdown formatting, includes all required sections with meaningful content (not placeholder text), and would be immediately useful to a developer. The tone and style are consistent with the reference `skills/csv-reader/SKILL.md`.
**Score 0.75**: The document is well-structured and mostly complete with good formatting. Minor issues such as a slightly inconsistent heading level, missing but non-critical fields (e.g., no author or version number), or slight deviation from the reference skill's formatting style.
**Score 0.5**: The document covers the required sections but feels incomplete or rough — terse descriptions, inconsistent formatting, or clearly not matching the register and style of the reference `csv-reader/SKILL.md`. Functional but not polished.
**Score 0.25**: The document is disorganized, missing multiple contextually important details, or formatted poorly enough to hinder readability. Has some required sections but would need significant revision before use.
**Score 0.0**: The output is barely structured, missing most contextual information, or so poorly formatted that it would not be usable as a skill document in the framework.