---
id: task_00033_ai_browser_project_git_initialization_and_workspace_setup
name: AI Browser Project Git Initialization and Workspace Setup
category: Workflow and Agent Orchestration
subcategory: Agent and AI Orchestration
grading_type: hybrid
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- path: ai_browser/__init__.py
  content: ''
- source: ai_browser/core.py
  dest: ai_browser/core.py
- source: ai_browser/cleaner.py
  dest: ai_browser/cleaner.py
- source: ai_browser/injector.py
  dest: ai_browser/injector.py
- path: ai_browser/template_engine.py
  content: "\"\"\"Template engine for structured output generation.\"\"\"\n\nclass TemplateEngine:\n    def __init__(self, templates_path=None):\n        self.templates_path = templates_path\n    \n    def render(self, template_name, data):\n        return str(data)\n"
- path: ai_browser/network_monitor.py
  content: "\"\"\"Network request monitoring and capture.\"\"\"\n\nclass NetworkMonitor:\n    def __init__(self):\n        self.captured = []\n    \n    def start(self):\n        pass\n    \n    def stop(self):\n        pass\n"
- path: ai_browser/main.py
  content: "\"\"\"Main entry point for AI Browser.\"\"\"\n\ndef main():\n    print(\"AI Browser starting...\")\n\nif __name__ == \"__main__\":\n    main()\n"
- path: config/json_templates.yaml
  content: "templates:\n  article:\n    fields:\n      - title\n      - content\n      - author\n      - date\n  news:\n    fields:\n      - headline\n      - body\n      - source\n"
- path: config/rules.yaml
  content: "cleaning_rules:\n  remove_selectors:\n    - \".ad\"\n    - \".advertisement\"\n    - \"#sidebar\"\n    - \".nav\"\n  keep_selectors:\n    - \"article\"\n    - \".content\"\n    - \".post-body\"\n"
- path: requirements.txt
  content: 'playwright>=1.40.0

    beautifulsoup4>=4.12.0

    pyyaml>=6.0

    markdownify>=0.11.0

    '
- path: requirements-test.txt
  content: 'pytest>=7.0.0

    pytest-asyncio>=0.21.0

    pytest-cov>=4.0.0

    '
- path: tests/__init__.py
  content: ''
- path: tests/fixtures/news_with_ads.html
  content: "<html>\n<body>\n  <nav>Navigation here</nav>\n  <div class=\"ad\">Buy stuff!</div>\n  <article>\n    <h1>Gold and Silver Recovery - Should You Hold Positions?</h1>\n    <p>Market analysis content here...</p>\n    <p>Expert opinions on precious metals...</p>\n  </article>\n  <div class=\"advertisement\">More ads</div>\n  <div id=\"sidebar\">Related links</div>\n</body>\n</html>\n"
- path: original-design.txt
  content: 'AI Browser Design Document

    ==========================


    Phase 1: Core content extraction with Playwright

    Phase 2: Template-based structured output (JSON/Markdown)

    Phase 3: Compliance, rate limiting, robots.txt checking


    Architecture:

    - core.py: Main browser engine

    - cleaner.py: Content cleaning pipeline

    - injector.py: Script injection for SPA support

    - template_engine.py: Output formatting

    - network_monitor.py: Request capture and analysis

    - compliance/: Rate limiting, robots.txt, user-agent management

    '
- path: wip.md
  content: '# Work in Progress


    ## Current Phase: Phase 3 - Compliance


    ### TODO

    - [x] Rate limiter implementation

    - [x] Robots.txt checker

    - [x] User agent rotation

    - [ ] Initialize git repository

    - [ ] Create project identity files (IDENTITY.md, etc.)

    - [ ] Set up compliance integration tests

    '
---

## Prompt

I've got this `ai_browser` project in my workspace. It's been in development for a while but has never been put under version control.

Can you help me get it set up properly? I need: initialize git and make an initial commit with the source code and configuration — there are some internal notes and work-in-progress files in here too, so use your judgment about what should and shouldn't go into version control. I'd also like a `workspace/.gitignore` appropriate for a Python/Playwright project, and two documentation files: an `workspace/IDENTITY.md` describing what this project is and where it currently stands, and a `workspace/BOOTSTRAP.md` with setup and getting-started instructions.

When writing the docs, please reflect the actual state of the codebase — not just what the planning documents say.

## Expected Behavior

The agent should:

1. **Read the workspace files** to understand the project — specifically `workspace/wip.md`, `workspace/original-design.txt`, `workspace/requirements.txt`, `workspace/requirements-test.txt`, and the Python modules in `ai_browser/` (core.py, cleaner.py, injector.py, template_engine.py, network_monitor.py).

2. **Detect the compliance gap**: `workspace/wip.md` marks Rate limiter, Robots.txt checker, and User agent rotation as done (✓), and `workspace/original-design.txt` describes Phase 3 as "Compliance, rate limiting, robots.txt checking". However, **no `compliance/` directory exists in the workspace**. The agent must notice this discrepancy and document it honestly in `workspace/IDENTITY.md` or `workspace/BOOTSTRAP.md`.

3. **Initialize git and make a selective initial commit**:
   - Stage source code (`ai_browser/*.py`), config (`config/*.yaml`), requirements, and tests
   - **Do NOT commit** `workspace/wip.md` (work-in-progress notes) and `workspace/original-design.txt` (internal design doc) — these are internal notes that should not go into the public repository
   - Make a first commit with an appropriate message

4. **Create `workspace/.gitignore`** appropriate for a Python/Playwright project. Must include at minimum: `__pycache__/`, `*.pyc`, `venv/` or `.venv/`, and ideally `.env`, `*.egg-info/`, `dist/`, `output/`.

5. **Create `workspace/IDENTITY.md`** that accurately describes the project, referencing actual class names and modules found in the workspace (e.g., `AIBrowser`, `ContentCleaner`, `ScriptInjector`, `TemplateEngine`, `NetworkMonitor`). Must honestly note that the compliance subpackage (rate limiting, robots.txt) is **missing from the codebase** despite being marked complete in workspace/wip.md.

6. **Create `workspace/BOOTSTRAP.md`** with specific setup instructions derived from the workspace — must reference `pip install -r requirements.txt` and `playwright install` (from the ImportError message in core.py), and `pytest` for running tests (from requirements-test.txt).

**Critical trap**: An agent that skips reading `workspace/wip.md` and `workspace/original-design.txt` will miss the compliance gap entirely and write workspace/IDENTITY.md claiming the project has compliance features it doesn't actually have. An agent that commits blindly with `git add .` will include `workspace/wip.md` and `workspace/original-design.txt` in the initial commit.

## Grading Criteria

- [ ] Git initialized and first commit made (refs/heads/master exists with a commit SHA)
- [ ] workspace/.gitignore exists with Python-specific entries (`__pycache__` and `*.pyc`/`venv/`)
- [ ] workspace/wip.md and workspace/original-design.txt are NOT in the initial commit (selective staging decision)
- [ ] workspace/IDENTITY.md references actual class names from the codebase (e.g., ContentCleaner, ScriptInjector, AIBrowser, TemplateEngine, NetworkMonitor)
- [ ] workspace/IDENTITY.md or workspace/BOOTSTRAP.md notes that compliance features (rate limiting, robots.txt) are absent from the codebase
- [ ] workspace/BOOTSTRAP.md contains specific setup commands derived from workspace files (pip install -r requirements.txt AND playwright install or pytest)

## Automated Checks

```python
import os
import re
import subprocess

def grade(transcript: list, workspace_path: str) -> dict:
    scores = {
        "git_initialized_with_commit": 0.0,
        "gitignore_created": 0.0,
        "wip_and_design_excluded": 0.0,
        "identity_references_actual_modules": 0.0,
        "compliance_gap_documented": 0.0,
        "bootstrap_has_specific_setup_commands": 0.0,
    }

    # Empty transcript guard
    if not transcript:
        return scores

    git_dir = os.path.join(workspace_path, ".git")

    # git_initialized_with_commit: .git exists AND first commit was made
    if os.path.isdir(git_dir):
        refs_master = os.path.join(git_dir, "refs", "heads", "master")
        refs_main = os.path.join(git_dir, "refs", "heads", "main")
        has_commit = False
        for ref_path in [refs_master, refs_main]:
            if os.path.isfile(ref_path):
                try:
                    with open(ref_path, "r") as f:
                        sha = f.read().strip()
                    if len(sha) >= 40:
                        has_commit = True
                        break
                except Exception:
                    pass
        # Also check packed-refs for branch references
        packed_refs = os.path.join(git_dir, "packed-refs")
        if not has_commit and os.path.isfile(packed_refs):
            try:
                with open(packed_refs, "r") as f:
                    content = f.read()
                if "refs/heads/master" in content or "refs/heads/main" in content:
                    has_commit = True
            except Exception:
                pass

        if has_commit:
            scores["git_initialized_with_commit"] = 1.0
        else:
            # Initialized but no commit
            scores["git_initialized_with_commit"] = 0.3

    # gitignore_created: .gitignore with Python-specific entries
    gitignore_path = os.path.join(workspace_path, ".gitignore")
    if os.path.isfile(gitignore_path):
        try:
            with open(gitignore_path, "r") as f:
                gi = f.read()
            has_pycache = "__pycache__" in gi
            has_pyc = "*.pyc" in gi or ".pyc" in gi
            has_venv = "venv" in gi or ".venv" in gi
            has_output = "output/" in gi or "output" in gi
            if has_pycache and has_pyc and has_venv:
                scores["gitignore_created"] = 1.0
            elif has_pycache and (has_pyc or has_venv):
                scores["gitignore_created"] = 0.7
            elif has_pycache:
                scores["gitignore_created"] = 0.4
            elif os.path.getsize(gitignore_path) > 10:
                scores["gitignore_created"] = 0.2
        except Exception:
            pass

    # wip_and_design_excluded: wip.md and original-design.txt not in initial commit
    # Uses subprocess to query git log; falls back to 0 if git unavailable or no commit
    if scores["git_initialized_with_commit"] >= 1.0:
        try:
            result = subprocess.run(
                ["git", "log", "--name-only", "--format=", "HEAD"],
                capture_output=True, text=True, cwd=workspace_path, timeout=10
            )
            committed_files = set(f.strip() for f in result.stdout.strip().split("\n") if f.strip())
            wip_excluded = "wip.md" not in committed_files
            design_excluded = "original-design.txt" not in committed_files
            if wip_excluded and design_excluded:
                scores["wip_and_design_excluded"] = 1.0
            elif wip_excluded or design_excluded:
                scores["wip_and_design_excluded"] = 0.5
        except Exception:
            pass

    # identity_references_actual_modules: IDENTITY.md mentions specific class names
    # that can only be discovered by reading the Python source files
    identity_path = os.path.join(workspace_path, "IDENTITY.md")
    if os.path.isfile(identity_path):
        try:
            with open(identity_path, "r") as f:
                identity = f.read()
            identity_lower = identity.lower()
            # Class names from the actual source files (not in stub/workspace description)
            class_names = [
                "contentcleaner", "cleaningstats", "scriptinjector",
                "templateengine", "networkmonitor", "browserconfig",
                "pagecontent", "aibrowser",
            ]
            # Module-level names (discoverable from directory listing)
            module_names = ["cleaner", "injector", "template_engine", "network_monitor"]
            identity_compact = identity_lower.replace(" ", "").replace("_", "")
            class_hits = sum(1 for c in class_names if c in identity_compact)
            module_hits = sum(1 for m in module_names if m in identity_lower)
            if class_hits >= 2:
                scores["identity_references_actual_modules"] = 1.0
            elif class_hits >= 1 or module_hits >= 3:
                scores["identity_references_actual_modules"] = 0.7
            elif module_hits >= 2:
                scores["identity_references_actual_modules"] = 0.4
            elif module_hits >= 1:
                scores["identity_references_actual_modules"] = 0.2
        except Exception:
            pass

    # compliance_gap_documented: docs note compliance code is missing from codebase
    # Requires reading wip.md (checkmarks) + checking workspace (no compliance/ dir)
    all_docs = ""
    for doc_file in ["IDENTITY.md", "BOOTSTRAP.md"]:
        p = os.path.join(workspace_path, doc_file)
        if os.path.isfile(p):
            try:
                with open(p, "r") as f:
                    all_docs += f.read().lower() + " "
            except Exception:
                pass
    has_compliance_mention = bool(re.search(r"compliance|rate.lim|robots\.txt", all_docs))
    has_gap_indication = bool(re.search(
        r"(not.*implement|missing|absent|incomplete|planned|todo|in.progress|not.*present|phase 3|not.*yet|future|pending)",
        all_docs
    ))
    if has_compliance_mention and has_gap_indication:
        scores["compliance_gap_documented"] = 1.0
    elif has_compliance_mention:
        scores["compliance_gap_documented"] = 0.4

    # bootstrap_has_specific_setup_commands: derived from reading workspace files
    bootstrap_path = os.path.join(workspace_path, "BOOTSTRAP.md")
    if os.path.isfile(bootstrap_path):
        try:
            with open(bootstrap_path, "r") as f:
                bs = f.read().lower()
            has_pip_req = bool(re.search(r"pip install.*requirements|pip install -r", bs))
            has_playwright = "playwright install" in bs
            has_pytest = "pytest" in bs
            if has_pip_req and (has_playwright or has_pytest):
                scores["bootstrap_has_specific_setup_commands"] = 1.0
            elif has_pip_req:
                scores["bootstrap_has_specific_setup_commands"] = 0.6
            elif "requirements" in bs or "playwright" in bs:
                scores["bootstrap_has_specific_setup_commands"] = 0.3
        except Exception:
            pass

    return scores
```

## LLM Judge Rubric

### Selective Commit and Version Control Setup (Weight: 30%)

- 1.0: Initial commit made with source code (`ai_browser/*.py`, `config/`, `requirements*.txt`, `tests/`) but NOT including `workspace/wip.md` or `workspace/original-design.txt`. `workspace/.gitignore` includes `__pycache__/`, `*.pyc`, `venv/`, and project-specific entries like `output/`. The agent explicitly considered what belongs in version control and excluded internal/work-in-progress files.
- 0.75: Initial commit made with most correct files; either workspace/wip.md or workspace/original-design.txt was excluded but not both, or workspace/.gitignore is present but missing some important entries.
- 0.5: Git initialized and commit made but with minimal workspace/.gitignore, or the agent committed everything including workspace/wip.md and workspace/original-design.txt without filtering.
- 0.25: Git initialized but no commit made, or commit structure is broken.
- 0.0: No git repository initialized, or .git directory is missing.

### Compliance Gap Awareness and Documentation (Weight: 30%)

- 1.0: workspace/IDENTITY.md or workspace/BOOTSTRAP.md explicitly notes that the compliance subpackage (rate limiting, robots.txt checking, user-agent rotation) is described as complete in `workspace/wip.md` but **no corresponding code exists** in the workspace. The documentation is honest about this gap and does not falsely claim compliance features are implemented.
- 0.75: Documentation acknowledges that compliance features are planned or in progress but doesn't explicitly reference the contradiction between workspace/wip.md checkmarks and missing code.
- 0.5: Documentation vaguely mentions "Phase 3" or "compliance" is upcoming/planned but doesn't connect it to the workspace/wip.md discrepancy.
- 0.25: Documentation either ignores compliance entirely or (worse) falsely claims compliance features are implemented.
- 0.0: No workspace/IDENTITY.md or workspace/BOOTSTRAP.md produced; or both files are present but claim compliance is fully implemented (directly contradicting what's actually in the workspace).

### Source-Grounded IDENTITY.md (Weight: 25%)

- 1.0: workspace/IDENTITY.md describes the project by referencing actual class/component names found in the source code (e.g., `AIBrowser`/`BrowserConfig`/`PageContent` from core.py, `ContentCleaner`/`CleaningStats` from cleaner.py, `ScriptInjector` from injector.py, `TemplateEngine`, `NetworkMonitor`). Accurately reflects what each component does based on reading the actual implementation.
- 0.75: workspace/IDENTITY.md references several actual module names correctly but may miss some class-level details or rely mostly on the directory listing rather than reading the code.
- 0.5: workspace/IDENTITY.md gives a reasonable description of the project but is generic and doesn't reference specific class/component names that would require reading the Python files.
- 0.25: workspace/IDENTITY.md is minimal, vague, or based entirely on the Prompt description without reading any workspace files.
- 0.0: workspace/IDENTITY.md is missing, empty, or describes a completely different project.

### Setup Instructions Accuracy (Weight: 15%)

- 1.0: workspace/BOOTSTRAP.md contains specific commands derived from reading workspace files: `pip install -r requirements.txt`, `playwright install` (from the ImportError message in core.py), and `pytest` for tests (from requirements-test.txt). Instructions are accurate and in the correct order.
- 0.75: workspace/BOOTSTRAP.md has pip install command and at least one of playwright install or pytest, but may miss one specific step.
- 0.5: workspace/BOOTSTRAP.md has generic install instructions (pip install) without the playwright install step or specific test commands.
- 0.25: workspace/BOOTSTRAP.md exists with minimal or vague instructions that don't reference the actual requirements files.
- 0.0: workspace/BOOTSTRAP.md is missing or empty.

---

grading_weights:
  automated: 0.4
  llm_judge: 0.6