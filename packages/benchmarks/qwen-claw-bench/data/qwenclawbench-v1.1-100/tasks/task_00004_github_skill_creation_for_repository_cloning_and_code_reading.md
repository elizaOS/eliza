---
id: task_00004_github_skill_creation_for_repository_cloning_and_code_reading
name: GitHub Skill Creation for Repository Cloning and Code Reading
category: System Operations and Administration
subcategory: Storage and Data Management
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: skills/github/SKILL.md
  dest: workspace/skills/github/SKILL.md
- source: skills/github/scripts/check-auth.sh
  dest: skills/github/scripts/check-auth.sh
- source: skills/gh/SKILL.md
  dest: workspace/skills/gh/SKILL.md
- source: skills/gh/references/gh-repo-commands.md
  dest: skills/gh/references/gh-repo-commands.md
- source: skills/skill-creator/SKILL.md
  dest: workspace/skills/skill-creator/SKILL.md
- source: skills/clawdhub/SKILL.md
  dest: workspace/skills/clawdhub/SKILL.md
- source: skills/weather/SKILL.md
  dest: workspace/skills/weather/SKILL.md
- source: skills/bluebubbles/SKILL.md
  dest: workspace/skills/bluebubbles/SKILL.md
- source: skills.json
  dest: skills.json
- source: config.yaml
  dest: config.yaml
- source: memory/2026-02-10.md
  dest: memory/2026-02-10.md
- source: data/clawdhub-search-results.json
  dest: data/clawdhub-search-results.json
- source: data/gateway-events.log
  dest: data/gateway-events.log
- source: data/skill-install-history.csv
  dest: data/skill-install-history.csv
---
## Prompt

Hey, can you upgrade `workspace/skills/github/SKILL.md`? The current version only covers gh CLI stuff — issues, PRs, CI runs — but I need it to also handle cloning repos and reading code. More importantly, it needs to work even when `gh` isn't installed. Make sure it handles both public and private repos, uses a token where needed, and includes a way to fetch file contents without cloning at all. Structure it like the other skills here. Update any other related files that should stay consistent.

## Expected Behavior

The agent should:

1. Read `memory/2026-02-10.md` to understand the request context. Inspect `skills.json` to see all installed skills, then read both `workspace/skills/github/SKILL.md` (current state — gh CLI focused, no YAML frontmatter) and `workspace/skills/gh/SKILL.md` (which already covers `gh repo clone`, issues, PRs, releases). Recognize that these two skills have overlapping scope and determine the correct architectural split.
2. Identify the key gap: `workspace/skills/gh/SKILL.md` already covers `gh repo clone` and gh-authenticated operations. The `github/SKILL.md` upgrade should therefore focus on **native `git clone`** (for environments without `gh`) and the **GitHub REST API** as a no-clone fallback — not duplicate `gh repo clone`. It should cross-reference `workspace/skills/gh/SKILL.md` for gh CLI operations.
3. Notice that `skills/github/scripts/check-auth.sh` only verifies gh CLI authentication. This is a coverage gap: the upgraded skill now introduces git-native token auth (via `GITHUB_TOKEN` embedded in the URL or `git credential`), which `check-auth.sh` does not test. The agent should note this limitation in the skill doc or update the script.
4. Update `workspace/skills/github/SKILL.md` with:
   - Proper YAML frontmatter (`name`, `description`) consistent with the `skill-creator` template.
   - A clear **tool availability hierarchy**: (a) if `gh` is installed → see `workspace/skills/gh/SKILL.md`; (b) if only `git` is available → use `git clone https://$GITHUB_TOKEN@github.com/<owner>/<repo>.git`; (c) if neither is available → fetch via `curl https://api.github.com/repos/<owner>/<repo>/contents/<path>` or `raw.githubusercontent.com`.
   - Explicit `--depth 1` shallow clone example for read-only scenarios.
   - A concrete example of fetching a single file via the REST API without cloning.
   - A cross-reference to `workspace/skills/gh/SKILL.md` making clear it handles issues, PRs, CI, and `gh repo clone`.
5. Update `skills.json` to bump the `github` skill version (from `2.1.0` to `2.2.0`) and update its description to reflect the new cloning and code-reading capabilities.
6. Summarize the changes made, explain the tool-availability hierarchy design decision, and call out the `check-auth.sh` limitation.

## Grading Criteria

- [ ] `workspace/skills/github/SKILL.md` exists and is substantial (more than 600 characters)
- [ ] SKILL.md has YAML frontmatter with both `name` and `description` fields
- [ ] SKILL.md contains native `git clone` instructions with token-auth URL format (e.g., `https://$GITHUB_TOKEN@github.com/...`) rather than just gh-based cloning
- [ ] SKILL.md includes GitHub REST API or raw content URL as a no-clone fallback with a concrete example
- [ ] SKILL.md explicitly cross-references `workspace/skills/gh/SKILL.md` (or `gh/SKILL.md`) for gh CLI operations, avoiding duplication
- [ ] SKILL.md does NOT use `gh repo clone` as the primary cloning method (native git is primary; gh clone belongs in `gh/SKILL.md`)
- [ ] `skills.json` updated: `github` skill version bumped and description updated to reflect clone/code-read capabilities

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import re
    import json

    scores = {
        "skill_file_exists_and_substantial": 0.0,
        "yaml_frontmatter_complete": 0.0,
        "git_clone_with_token_auth": 0.0,
        "api_fallback_with_concrete_example": 0.0,
        "cross_references_gh_skill": 0.0,
        "avoids_gh_clone_as_primary": 0.0,
        "skills_json_updated": 0.0,
    }

    skill_path = os.path.join(workspace_path, "skills", "github", "SKILL.md")

    if not os.path.isfile(skill_path):
        return scores

    try:
        with open(skill_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return scores

    # 1. Substantial content (upgraded skill should be thorough)
    length = len(content.strip())
    if length > 600:
        scores["skill_file_exists_and_substantial"] = 1.0
    elif length > 300:
        scores["skill_file_exists_and_substantial"] = 0.6
    elif length > 100:
        scores["skill_file_exists_and_substantial"] = 0.25

    # 2. YAML frontmatter with both name and description
    fm_match = re.search(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if fm_match:
        fm = fm_match.group(1)
        has_name = bool(re.search(r"^\s*name\s*:", fm, re.MULTILINE))
        has_desc = bool(re.search(r"^\s*description\s*:", fm, re.MULTILINE))
        if has_name and has_desc:
            scores["yaml_frontmatter_complete"] = 1.0
        elif has_name or has_desc:
            scores["yaml_frontmatter_complete"] = 0.5

    content_lower = content.lower()

    # 3. git clone with token-auth URL pattern (not just the word "token")
    # Must show native git-based authentication, e.g. https://$GITHUB_TOKEN@github.com/...
    has_git_clone = bool(re.search(r"git\s+clone", content_lower))
    token_url_patterns = [
        r"github_token@",
        r"\$github_token@",
        r"https://.*token.*@github",
        r"https://oauth2:.*@github",
        r"x-access-token:.*@github",
        r"git\s+credential",
        r"\.netrc",
    ]
    has_token_url = any(re.search(p, content_lower) for p in token_url_patterns)
    # Also accept GITHUB_TOKEN in URL context even without exact format
    has_token_context = bool(
        re.search(r"github_token", content_lower) and re.search(r"git\s+clone", content_lower)
    )
    if has_git_clone and has_token_url:
        scores["git_clone_with_token_auth"] = 1.0
    elif has_git_clone and has_token_context:
        scores["git_clone_with_token_auth"] = 0.7
    elif has_git_clone:
        scores["git_clone_with_token_auth"] = 0.4

    # 4. API fallback with concrete example (must have URL pattern, not just keyword)
    concrete_api_patterns = [
        r"api\.github\.com",
        r"raw\.githubusercontent\.com",
        r"/repos/[a-z<{$]",
        r"curl.*github",
        r"wget.*github",
    ]
    api_hits = sum(1 for p in concrete_api_patterns if re.search(p, content_lower))
    if api_hits >= 2:
        scores["api_fallback_with_concrete_example"] = 1.0
    elif api_hits == 1:
        scores["api_fallback_with_concrete_example"] = 0.5

    # 5. Cross-references gh/SKILL.md to avoid duplication
    cross_ref_patterns = [
        r"skills/gh",
        r"gh/skill",
        r"gh skill",
        r"see.*\bgh\b.*skill",
        r"refer.*\bgh\b",
    ]
    if any(re.search(p, content_lower) for p in cross_ref_patterns):
        scores["cross_references_gh_skill"] = 1.0
    elif re.search(r"\bgh\b.*\bskill\b|\bskill\b.*\bgh\b", content_lower):
        scores["cross_references_gh_skill"] = 0.5

    # 6. Does NOT use gh repo clone as primary method
    # (gh/SKILL.md already covers this; github/SKILL.md should lead with git clone)
    git_clone_count = len(re.findall(r"\bgit\s+clone\b", content_lower))
    gh_repo_clone_count = len(re.findall(r"\bgh\s+repo\s+clone\b", content_lower))
    if git_clone_count >= 1 and gh_repo_clone_count == 0:
        scores["avoids_gh_clone_as_primary"] = 1.0
    elif git_clone_count >= 1 and git_clone_count > gh_repo_clone_count:
        scores["avoids_gh_clone_as_primary"] = 0.6
    elif git_clone_count >= 1:
        scores["avoids_gh_clone_as_primary"] = 0.3

    # 7. skills.json updated with new description and/or version for github skill
    skills_json_path = os.path.join(workspace_path, "skills.json")
    try:
        with open(skills_json_path, "r", encoding="utf-8") as f:
            skills_data = json.load(f)
        original_desc = "interact with github using the gh cli"
        for skill in skills_data.get("installed", []):
            if skill.get("name") == "github":
                desc = skill.get("description", "").lower()
                version = skill.get("version", "")
                desc_updated = original_desc not in desc or any(
                    kw in desc for kw in ["clone", "code", "read", "git clone"]
                )
                version_updated = version != "2.1.0"
                if desc_updated and version_updated:
                    scores["skills_json_updated"] = 1.0
                elif desc_updated or version_updated:
                    scores["skills_json_updated"] = 0.5
                break
    except Exception:
        pass

    return scores
```

## LLM Judge Rubric

### Tool Availability Hierarchy and Architecture (Weight: 30%)
Evaluates whether the agent correctly identified and resolved the overlap between `github/SKILL.md` and `gh/SKILL.md`, and structured the upgrade around a proper fallback hierarchy.

- **1.0**: Agent explicitly recognized that `gh/SKILL.md` already covers `gh repo clone`, issues, PRs, and releases. The upgraded `github/SKILL.md` uses native `git clone` as primary (for gh-absent environments), GitHub REST API as secondary fallback, and cross-references `gh/SKILL.md` for gh-specific operations — zero duplication.
- **0.75**: Agent acknowledged the overlap and used `git clone` as primary, but cross-reference to `gh/SKILL.md` is vague or the hierarchy is not clearly expressed.
- **0.5**: Agent added `git clone` but also duplicated `gh repo clone` content from `gh/SKILL.md` without justification, or hierarchy is ambiguous.
- **0.25**: Agent treated `gh repo clone` as the main method and only added `git clone` as a footnote, missing the point of the gh-absent use case.
- **0.0**: No evidence of recognizing the overlap. `github/SKILL.md` is essentially a copy of `gh/SKILL.md` with minor additions, or no new cloning content was added.

### Technical Accuracy and Concreteness (Weight: 25%)
Evaluates whether the skill provides correct, runnable instructions for real-world use.

- **1.0**: Includes concrete `git clone https://$GITHUB_TOKEN@github.com/<owner>/<repo>.git` (or equivalent token-in-URL syntax) for private repos; includes a concrete `curl https://api.github.com/repos/<owner>/<repo>/contents/<path>` example with `-H "Authorization: token $GITHUB_TOKEN"`; mentions `--depth 1` shallow clone; covers public vs private distinction.
- **0.75**: Most commands are concrete and correct, but one element is missing (e.g., missing shallow clone or missing Authorization header in API example).
- **0.5**: Commands are present but imprecise — e.g., shows token support only as a vague note without a concrete URL format, or API example lacks auth header.
- **0.25**: Only generic git/API mentions without concrete syntax; a developer could not use these instructions directly.
- **0.0**: No concrete commands or instructions provided; content is vague prose.

### Skill Structure and Format Compliance (Weight: 20%)
Evaluates YAML frontmatter correctness and section organization per `skill-creator` conventions.

- **1.0**: SKILL.md has proper YAML frontmatter (`name`, `description`), uses the `skill-creator` template structure (Trigger/Prerequisites/Usage/Notes or equivalent), and is clearly organized with ≥4 distinct H2 sections. Overall quality is comparable to reference skills like `skill-creator` or `clawdhub`.
- **0.75**: Frontmatter present with both fields, good sections, but structure slightly deviates from convention or one section is thin.
- **0.5**: Frontmatter partially correct (only one field) or sections present but not meaningfully organized.
- **0.25**: SKILL.md exists with some structure but no frontmatter, or frontmatter exists but no sections.
- **0.0**: SKILL.md unchanged from original, missing, or without any meaningful structure.

### Cross-File Consistency (Weight: 15%)
Evaluates whether the agent kept related files consistent with the upgraded skill.

- **1.0**: `skills.json` updated with a bumped version (≥2.2.0) and a description that reflects the new clone/code-reading capabilities. Agent also noted or addressed the `check-auth.sh` limitation (covers only gh auth, not git token auth).
- **0.75**: `skills.json` version or description updated (one of the two), and `check-auth.sh` limitation is mentioned.
- **0.5**: `skills.json` updated in one of the two fields, no mention of `check-auth.sh`.
- **0.25**: Agent acknowledged the need to update `skills.json` but did not actually modify it.
- **0.0**: `skills.json` left unchanged; no mention of `check-auth.sh` limitation.

### Workspace Investigation Quality (Weight: 10%)
Evaluates whether the agent grounded its work in actual workspace state.

- **1.0**: Agent read `memory/2026-02-10.md`, `skills.json`, `workspace/skills/github/SKILL.md`, and `workspace/skills/gh/SKILL.md`. Used `data/clawdhub-search-results.json` or `skill-install-history.csv` as supporting context. Tailored output to the actual workspace.
- **0.75**: Agent read the key skill files and memory but missed one secondary context file.
- **0.5**: Agent read the existing `github/SKILL.md` but did not compare with `gh/SKILL.md` or did not check memory.
- **0.25**: Minimal investigation; skill appears generic, no reference to workspace context.
- **0.0**: No evidence of reading any existing files.