---
id: task_00016_moltbook_auto_post_skill_creation
name: Moltbook Auto Post Skill Creation
category: Workflow and Agent Orchestration
subcategory: Script and Terminal Automation
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: skills/moltbook-auto-post/post.js
  dest: skills/moltbook-auto-post/post.js
- source: skills/moltbook-auto-post/config.json
  dest: skills/moltbook-auto-post/config.json
- source: skills/moltbook-auto-post/package.json
  dest: skills/moltbook-auto-post/package.json
- source: skills/moltbook-auto-post/SKILL.md
  dest: skills/moltbook-auto-post/SKILL.md
- source: skills/moltbook-auto-post/post-history.json
  dest: skills/moltbook-auto-post/post-history.json
- source: skills/moltbook-auto-post/templates/bookmark-dump.md
  dest: skills/moltbook-auto-post/templates/bookmark-dump.md
- source: skills/moltbook-auto-post/templates/curious.md
  dest: skills/moltbook-auto-post/templates/curious.md
- source: skills/moltbook-auto-post/templates/hot-take.md
  dest: skills/moltbook-auto-post/templates/hot-take.md
- source: skills/moltbook-auto-post/templates/listicle.txt
  dest: skills/moltbook-auto-post/templates/listicle.txt
---

## Prompt

[cron:580e0167-c33d-4282-bcd6-ea1f11f4418b Moltbook Auto Post] node skills/moltbook-auto-post/post.js
Current time: Tuesday, February 10th, 2026 — 6:23 PM (Asia/Shanghai)

The cron job above keeps failing silently. I'd like you to do two things:

1. **Create a reusable skill** as a `SKILL.md` file in the workspace root that describes how to diagnose and fix broken scheduled automation scripts. Think of it as a general "scheduled script troubleshooter" skill — covering credential/config checks, dependency verification, rate limit analysis, and execution testing.

2. **Use that skill** to diagnose what's wrong with the moltbook-auto-post setup, check everything thoroughly, and write a status report to `diagnosis-report.md` in the workspace root. The report should explain what's broken, what was fixed, and what still needs manual action.

## Expected Behavior

The agent should:

1. **Examine the existing workspace** — read `skills/moltbook-auto-post/post.js`, `skills/moltbook-auto-post/config.json`, and `skills/moltbook-auto-post/package.json` to understand the automation setup.

2. **Create `SKILL.md`** in the workspace root with:
   - YAML frontmatter containing `name` and `description` fields
   - Markdown sections describing a reusable methodology for diagnosing broken scheduled scripts
   - Coverage of: credential/config checks, dependency verification, rate limit analysis, and execution testing

3. **Diagnose the moltbook-auto-post issues**, identifying at minimum:
   - The empty `accessToken` field in `skills/moltbook-auto-post/config.json` (`moltbook.accessToken: ""`)
   - Missing `node_modules` / uninstalled dependencies (`node-fetch`, `dayjs`)
   - The script exits with FATAL error code 1 due to missing dependencies (before token check)

4. **Cross-reference `skills/moltbook-auto-post/post-history.json` with rate limit config**: Read `skills/moltbook-auto-post/post-history.json` — the last post was at `2026-02-10T07:55:12Z` (UTC). The cron fires at 6:23 PM Asia/Shanghai = `2026-02-10T10:23:00Z` (UTC). Elapsed time is 148 minutes. `skills/moltbook-auto-post/config.json` specifies `rateLimit.minIntervalMinutes: 180`. Therefore, even if dependencies were installed and the token were provided, the script would still exit with a rate limit warning (not post) until `2026-02-10T10:55:12Z` = 6:55 PM Asia/Shanghai — 32 minutes after the cron run time.

5. **Create `diagnosis-report.md`** in the workspace root containing:
   - Summary of issues found (missing deps, empty token, rate limit conflict)
   - What was fixed or attempted
   - What requires manual intervention (real token)
   - Rate limit status: next eligible post time

6. **Optionally install dependencies** (`cd skills/moltbook-auto-post && npm install`) as a fixable item.

## Grading Criteria

- [ ] SKILL.md exists with proper YAML frontmatter (name and description fields)
- [ ] SKILL.md contains meaningful diagnostic methodology sections
- [ ] diagnosis-report.md exists in workspace root
- [ ] diagnosis-report.md identifies key issues (empty access token and missing dependencies)
- [ ] diagnosis-report.md distinguishes between fixable and manual-intervention items
- [ ] Agent identified the rate limit conflict: last post was 148 minutes ago but minimum interval is 180 minutes (requires cross-referencing skills/moltbook-auto-post/post-history.json with skills/moltbook-auto-post/config.json and the cron timestamp)

## Automated Checks

```python
import os
import re

def grade(transcript: list, workspace_path: str) -> dict:
    scores = {
        "skill_md_exists_and_structured": 0.0,
        "skill_md_content_quality": 0.0,
        "diagnosis_report_exists": 0.0,
        "diagnosis_report_identifies_issues": 0.0,
        "diagnosis_report_manual_vs_fixed": 0.0,
        "identifies_rate_limit_conflict": 0.0,
    }

    if not transcript:
        return scores

    # 1. Check SKILL.md exists and has YAML frontmatter
    skill_path = os.path.join(workspace_path, "SKILL.md")
    if os.path.isfile(skill_path):
        try:
            with open(skill_path, "r", encoding="utf-8") as f:
                skill_content = f.read()
        except Exception:
            skill_content = ""

        frontmatter_match = re.search(r'^---\s*\n(.*?)\n---', skill_content, re.DOTALL)
        if frontmatter_match:
            fm = frontmatter_match.group(1)
            has_name = bool(re.search(r'name\s*:', fm))
            has_desc = bool(re.search(r'description\s*:', fm))
            if has_name and has_desc:
                scores["skill_md_exists_and_structured"] = 1.0
            elif has_name or has_desc:
                scores["skill_md_exists_and_structured"] = 0.5
            else:
                scores["skill_md_exists_and_structured"] = 0.2
        else:
            scores["skill_md_exists_and_structured"] = 0.15

    # 2. Check SKILL.md content quality
    if os.path.isfile(skill_path):
        try:
            with open(skill_path, "r", encoding="utf-8") as f:
                skill_lower = f.read().lower()
        except Exception:
            skill_lower = ""

        quality_keywords = ["credential", "config", "dependenc", "diagnos", "troubleshoot",
                            "token", "fix", "verif", "execut", "script", "rate.limit", "interval"]
        matched = sum(1 for kw in quality_keywords if re.search(kw, skill_lower))
        has_headings = bool(re.search(r'^#{1,3}\s+', skill_lower, re.MULTILINE))

        if matched >= 6 and has_headings:
            scores["skill_md_content_quality"] = 1.0
        elif matched >= 4 and has_headings:
            scores["skill_md_content_quality"] = 0.75
        elif matched >= 3 and has_headings:
            scores["skill_md_content_quality"] = 0.5
        elif matched >= 2:
            scores["skill_md_content_quality"] = 0.25

    # 3. Check diagnosis-report.md exists
    report_path = os.path.join(workspace_path, "diagnosis-report.md")
    report_content = ""
    if os.path.isfile(report_path):
        scores["diagnosis_report_exists"] = 1.0
        try:
            with open(report_path, "r", encoding="utf-8") as f:
                report_content = f.read()
        except Exception:
            pass
    else:
        for alt in ["diagnosis_report.md", "DIAGNOSIS-REPORT.md", "report.md", "status-report.md"]:
            alt_path = os.path.join(workspace_path, alt)
            if os.path.isfile(alt_path):
                scores["diagnosis_report_exists"] = 0.75
                try:
                    with open(alt_path, "r", encoding="utf-8") as f:
                        report_content = f.read()
                except Exception:
                    pass
                break

    # 4. Check report identifies key issues
    if report_content:
        rc_lower = report_content.lower()
        found_token = bool(re.search(
            r"(access.token|accesstoken|moltbook.token|token.{0,20}(empty|missing|blank)|"
            r"empty.{0,20}token|no.token|credential)",
            rc_lower
        ))
        found_deps = bool(re.search(
            r"(node.fetch|dayjs|node_modules|npm.install|dependenc.{0,20}(miss|not|install))",
            rc_lower
        ))
        issue_score = 0.0
        if found_token:
            issue_score += 0.5
        if found_deps:
            issue_score += 0.5
        scores["diagnosis_report_identifies_issues"] = min(issue_score, 1.0)

    # 5. Check report distinguishes fixable vs manual intervention
    if report_content:
        rc_lower = report_content.lower()
        mentions_manual = bool(re.search(
            r"(manual|user.action|provide.{0,20}token|need.{0,20}(real|actual|valid).{0,20}token|"
            r"requires.{0,20}intervention|human.{0,20}action|cannot.automate)",
            rc_lower
        ))
        mentions_fixed = bool(re.search(
            r"(fixed|resolved|installed|npm.install|attempted|corrected|still.{0,20}(broken|pending))",
            rc_lower
        ))
        if mentions_manual and mentions_fixed:
            scores["diagnosis_report_manual_vs_fixed"] = 1.0
        elif mentions_manual:
            scores["diagnosis_report_manual_vs_fixed"] = 0.6
        elif mentions_fixed:
            scores["diagnosis_report_manual_vs_fixed"] = 0.4

    # 6. Check rate limit conflict identification
    # last post: 2026-02-10T07:55:12Z, cron time: 10:23 UTC, elapsed 148min, threshold 180min
    # agent should identify: rate limited, 32 minutes remaining, next post at 10:55 UTC / 18:55 Asia/Shanghai
    assistant_text = ""
    for m in transcript:
        if not isinstance(m, dict):
            continue
        if m.get("role") == "assistant":
            content = m.get("content", "")
            if isinstance(content, str):
                assistant_text += content + " "
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict):
                        assistant_text += str(block.get("text", "") or block.get("input", "")) + " "

    text_lower = assistant_text.lower()

    has_rate_limit_identified = bool(re.search(
        r"(rate.limit.{0,60}(block|prevent|trigger|active|hit|still|remain|not.yet)|"
        r"min.interval.{0,30}(180|not.met|not.elapsed|too.soon)|"
        r"148.{0,10}min|32.{0,10}min.{0,20}(remain|left|until|before)|"
        r"10:55|18:55|07:55.{0,60}(rate|interval|limit)|"
        r"last.post.{0,80}(148|rate|interval|limit|block|prevent)|"
        r"(rate|interval).{0,40}07:55|minintervalminutes)",
        text_lower
    ))
    has_history_reference = bool(re.search(
        r"(post.history|history\.json|post_[a-z0-9]+|07:55|last.post.{0,40}(07|02-10T07))",
        text_lower
    ))
    if has_rate_limit_identified and has_history_reference:
        scores["identifies_rate_limit_conflict"] = 1.0
    elif has_rate_limit_identified:
        scores["identifies_rate_limit_conflict"] = 0.75
    elif bool(re.search(r"(rate.limit|post.history|mininterval)", text_lower)):
        scores["identifies_rate_limit_conflict"] = 0.25

    return scores
```

## LLM Judge Rubric

### Rate Limit Cross-Reference Analysis (Weight: 30%)

Evaluates whether the agent read `skills/moltbook-auto-post/post-history.json`, cross-referenced the last post timestamp with `skills/moltbook-auto-post/config.json`'s `rateLimit.minIntervalMinutes`, and identified that the script would still be rate-limited at cron run time.

- **1.0**: Agent correctly identified all three elements: (a) last post in `skills/moltbook-auto-post/post-history.json` at `2026-02-10T07:55:12Z`; (b) `minIntervalMinutes: 180` from `skills/moltbook-auto-post/config.json`; (c) elapsed time of ~148 minutes is less than 180, so the script would still exit with rate limit warning even after fixing the token and dependencies. Reports next eligible post time (approximately 10:55 UTC / 18:55 Asia/Shanghai).
- **0.75**: Identified the rate limit conflict and referenced skills/moltbook-auto-post/post-history.json, but was imprecise about the exact times or remaining wait.
- **0.5**: Mentioned rate limiting as a potential issue but did not cite specific values from skills/moltbook-auto-post/post-history.json or skills/moltbook-auto-post/config.json.
- **0.25**: Noted skills/moltbook-auto-post/post-history.json exists or mentioned rate limits, but did not analyze whether a conflict exists.
- **0.0**: Did not read skills/moltbook-auto-post/post-history.json or ignored rate limit entirely.

### Diagnosis Accuracy and Completeness (Weight: 25%)

Evaluates whether the agent correctly identified all issues with the moltbook-auto-post setup.

- **1.0**: Identifies all three layers: (a) missing `node-fetch`/`dayjs` dependencies causing immediate FATAL exit; (b) empty `moltbook.accessToken` in `skills/moltbook-auto-post/config.json`; (c) rate limit conflict from skills/moltbook-auto-post/post-history.json. Notes that missing deps fail before token check.
- **0.75**: Identifies the dependency and token issues but misses the rate limit conflict, or gets the failure order wrong.
- **0.5**: Identifies at least one major issue (token or dependencies) but misses the other and the rate limit.
- **0.25**: Vaguely mentions something is wrong without pinpointing specific issues.
- **0.0**: No diagnosis performed or diagnosis is entirely wrong.

### Evidence and Workspace Grounding (Weight: 20%)

Evaluates whether the agent examined workspace files and grounded analysis in real file contents.

- **1.0**: Agent clearly read `skills/moltbook-auto-post/post.js`, `skills/moltbook-auto-post/config.json`, `skills/moltbook-auto-post/package.json`, and `skills/moltbook-auto-post/post-history.json`; diagnosis references specific file contents (e.g., empty `accessToken`, `node-fetch`/`dayjs` dependency names, last post timestamp from history).
- **0.75**: Agent read most relevant files but skipped skills/moltbook-auto-post/post-history.json.
- **0.5**: Agent read some files but the report contains unsupported claims.
- **0.25**: Agent made minimal effort; mostly guessing from symptom description.
- **0.0**: No evidence of reading workspace files; output is entirely hallucinated.

### Skill Design Quality (Weight: 15%)

Evaluates whether the SKILL.md file represents a well-structured, reusable troubleshooting skill.

- **1.0**: SKILL.md has proper YAML frontmatter, clear sections covering credential checks, dependency verification, rate limit analysis, and execution testing.
- **0.75**: SKILL.md exists with frontmatter and covers most diagnostic areas but omits rate limit analysis.
- **0.5**: SKILL.md exists but is thin — covers only 1-2 diagnostic areas.
- **0.25**: SKILL.md exists but is a stub.
- **0.0**: SKILL.md is missing or empty.

### Report Clarity and Actionability (Weight: 10%)

Evaluates whether `diagnosis-report.md` is clear and provides actionable next steps.

- **1.0**: Report is well-structured with clear sections, distinguishes what was fixed vs manual action, and specifies next eligible post time given the rate limit.
- **0.75**: Report is clear and mostly actionable but could be better organized.
- **0.5**: Report exists and conveys main points but is disorganized or vague on next steps.
- **0.25**: Report exists but is hard to follow or missing actionable guidance.
- **0.0**: Report is missing, empty, or incomprehensible.
