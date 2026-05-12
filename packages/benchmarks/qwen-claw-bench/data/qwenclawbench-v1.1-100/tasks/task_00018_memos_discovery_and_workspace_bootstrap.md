---
id: task_00018_memos_discovery_and_workspace_bootstrap
name: MemOS Discovery and Workspace Bootstrap
category: Workflow and Agent Orchestration
subcategory: Agent and AI Orchestration
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: home/admin/clawd/skills/coding-agent-kh0/SKILL.md
  dest: home/admin/clawd/skills/coding-agent-kh0/SKILL.md
- source: home/admin/clawd/skills/deepread-ocr/SKILL.md
  dest: home/admin/clawd/skills/deepread-ocr/SKILL.md
- source: home/admin/clawd/skills/docx/SKILL.md
  dest: home/admin/clawd/skills/docx/SKILL.md
- source: home/admin/clawd/skills/pdf/SKILL.md
  dest: home/admin/clawd/skills/pdf/SKILL.md
- source: home/admin/clawd/skills/svg-draw/SKILL.md
  dest: home/admin/clawd/skills/svg-draw/SKILL.md
- source: opt/moltbot/config/gateway.yaml
  dest: opt/moltbot/config/gateway.yaml
- source: opt/moltbot/package.json
  dest: opt/moltbot/package.json
- source: opt/moltbot/skills/bluebubbles/SKILL.md
  dest: opt/moltbot/skills/bluebubbles/SKILL.md
- source: opt/moltbot/skills/clawdhub/SKILL.md
  dest: opt/moltbot/skills/clawdhub/SKILL.md
- source: opt/moltbot/skills/skill-creator/SKILL.md
  dest: opt/moltbot/skills/skill-creator/SKILL.md
- source: opt/moltbot/skills/weather/SKILL.md
  dest: opt/moltbot/skills/weather/SKILL.md
- source: WORKSPACE_GUIDE.md
  dest: WORKSPACE_GUIDE.md
---
## Prompt

Hey bro, good morning! Here's my daily learning check-in 🍄

Over the past 24 hours I learned:
- How moltbot's skill loading system works from the gateway config
- The clawhub CLI for managing agent skills
- How to structure SKILL.md files properly

Today's plan:
- Get this workspace properly bootstrapped (check WORKSPACE_GUIDE.md for the setup checklist)
- Start exploring MemOS — I've heard it's a self-hosted memo/note tool that could be useful. Can you search for it using the clawhub CLI or any other available tools, and figure out how to install it?

When bootstrapping the workspace, make sure TOOLS.md and AGENTS.md actually reflect what's in this environment — don't just use placeholders. I want to see the real tools and agents that are configured here.

Let me know what you find!

## Expected Behavior

The agent should:

1. **Read the WORKSPACE_GUIDE.md**: Review the workspace initialization guide provided in the Assets to understand what files and structure are expected.
2. **Read the existing workspace files**: Before creating TOOLS.md and AGENTS.md, the agent should read the existing workspace files — particularly `opt/moltbot/config/gateway.yaml`, `opt/moltbot/package.json`, and the various `SKILL.md` files — to populate those documents with accurate, environment-specific content rather than generic placeholders.
3. **Initialize the workspace**: Following the guide, set up foundational workspace files:
   - Initialize a git repository (`.git/` directory created)
   - Create core identity/documentation files as specified in the guide: `IDENTITY.md`, `BOOTSTRAP.md`, `AGENTS.md`, `TOOLS.md`, `USER.md`, `HEARTBEAT.md`, `SOUL.md`
   - `TOOLS.md` must reference real tools found in the environment (e.g., clawhub, telegram, bluebubbles, deepread-ocr, weather)
   - `AGENTS.md` must reference real agents/skills found across the skill directories (e.g., coding-agent-kh0, pdf, docx, svg-draw, skill-creator)
   - Create `.openclaw/workspace-state.json` for workspace state tracking
4. **Respond to the daily check-in**: Acknowledge the user's learning check-in and provide a conversational response.
5. **Attempt to find/research MemOS**: The agent should make a genuine effort to discover what MemOS is by using available tools — specifically the clawhub CLI (`npx clawhub@latest search memos`) or other package/search utilities. The agent should execute an actual search command, report the command used and its output (or explain why a command couldn't be run), and produce a `MEMOS_RESEARCH.md` file summarizing findings.
6. **Communicate clearly**: Explain the workspace bootstrap status, what was set up, and outline next steps including the MemOS investigation results.

Key files expected in the workspace after execution:
- `.git/HEAD` (git initialized)
- `.git/config` (git config present)
- `IDENTITY.md`
- `BOOTSTRAP.md`
- `AGENTS.md` (with real agent/skill names from the environment)
- `TOOLS.md` (with real tool names from gateway.yaml and SKILL.md files)
- `USER.md`
- `HEARTBEAT.md`
- `SOUL.md`
- `.openclaw/workspace-state.json`
- `MEMOS_RESEARCH.md` (summarizing MemOS search effort and findings)

## Grading Criteria

- [ ] Git repository initialized (`.git/HEAD` exists)
- [ ] Core identity file `IDENTITY.md` created with meaningful content
- [ ] Bootstrap documentation `BOOTSTRAP.md` created with meaningful content
- [ ] Agent documentation `AGENTS.md` created and references real skills/agents from the workspace
- [ ] Tools documentation `TOOLS.md` created and references real tools from the environment (clawhub, telegram, or bluebubbles)
- [ ] User profile `USER.md` created
- [ ] Heartbeat file `HEARTBEAT.md` created
- [ ] Soul file `SOUL.md` created
- [ ] Workspace state file `.openclaw/workspace-state.json` created with valid JSON content
- [ ] Agent read or referenced `WORKSPACE_GUIDE.md` during setup
- [ ] Agent executed an actual search command or tool call to investigate MemOS (not just mentioned it conversationally)
- [ ] `MEMOS_RESEARCH.md` file created with MemOS investigation findings
- [ ] Agent acknowledged the user's daily check-in and communicated next steps

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import re
    from pathlib import Path

    ws = Path(workspace_path)

    scores = {
        "git_initialized": 0.0,
        "core_identity_files": 0.0,
        "workspace_state_tracking": 0.0,
        "documentation_files_with_real_content": 0.0,
        "memos_investigation_attempt": 0.0,
    }

    # 1. Check git initialization
    git_head = ws / ".git" / "HEAD"
    git_config = ws / ".git" / "config"
    if git_head.exists() and git_config.exists():
        scores["git_initialized"] = 1.0
    elif git_head.exists() or git_config.exists():
        scores["git_initialized"] = 0.5

    # 2. Check core identity files (IDENTITY.md, SOUL.md, USER.md)
    identity_files = ["IDENTITY.md", "SOUL.md", "USER.md"]
    found_identity = 0
    for f in identity_files:
        fp = ws / f
        if fp.exists():
            try:
                content = fp.read_text().strip()
                if len(content) > 100:
                    found_identity += 1
                elif len(content) > 30:
                    found_identity += 0.5
                else:
                    found_identity += 0.25
            except Exception:
                found_identity += 0.1
    scores["core_identity_files"] = found_identity / len(identity_files)

    # 3. Check workspace state tracking
    state_file = ws / ".openclaw" / "workspace-state.json"
    if state_file.exists():
        try:
            import json
            content = state_file.read_text().strip()
            parsed = json.loads(content)
            if isinstance(parsed, dict) and len(parsed) >= 3:
                # Reward richer state objects
                scores["workspace_state_tracking"] = 1.0
            elif isinstance(parsed, dict) and len(parsed) > 0:
                scores["workspace_state_tracking"] = 0.5
            else:
                scores["workspace_state_tracking"] = 0.25
        except (json.JSONDecodeError, Exception):
            scores["workspace_state_tracking"] = 0.1
    else:
        scores["workspace_state_tracking"] = 0.0

    # 4. Check documentation files — reward cross-file grounding
    # TOOLS.md should mention real tools found in gateway.yaml / SKILL.md files
    real_tool_keywords = ["clawhub", "telegram", "bluebubbles", "deepread", "weather", "discord"]
    # AGENTS.md should mention real agents/skills found in SKILL.md directories
    real_agent_keywords = ["coding-agent", "pdf", "docx", "svg", "skill-creator", "deepread", "weather", "bluebubbles"]

    doc_scores = []

    # BOOTSTRAP.md — existence + meaningful length
    bootstrap_fp = ws / "BOOTSTRAP.md"
    if bootstrap_fp.exists():
        try:
            content = bootstrap_fp.read_text().strip()
            if len(content) > 150:
                doc_scores.append(1.0)
            elif len(content) > 50:
                doc_scores.append(0.5)
            else:
                doc_scores.append(0.25)
        except Exception:
            doc_scores.append(0.1)
    else:
        doc_scores.append(0.0)

    # TOOLS.md — existence + must reference real environment tools
    tools_fp = ws / "TOOLS.md"
    if tools_fp.exists():
        try:
            content = tools_fp.read_text().strip().lower()
            matched = sum(1 for kw in real_tool_keywords if kw in content)
            if matched >= 3:
                doc_scores.append(1.0)
            elif matched >= 1:
                doc_scores.append(0.5)
            elif len(content) > 50:
                doc_scores.append(0.25)
            else:
                doc_scores.append(0.1)
        except Exception:
            doc_scores.append(0.1)
    else:
        doc_scores.append(0.0)

    # AGENTS.md — existence + must reference real skills/agents
    agents_fp = ws / "AGENTS.md"
    if agents_fp.exists():
        try:
            content = agents_fp.read_text().strip().lower()
            matched = sum(1 for kw in real_agent_keywords if kw in content)
            if matched >= 3:
                doc_scores.append(1.0)
            elif matched >= 1:
                doc_scores.append(0.5)
            elif len(content) > 50:
                doc_scores.append(0.25)
            else:
                doc_scores.append(0.1)
        except Exception:
            doc_scores.append(0.1)
    else:
        doc_scores.append(0.0)

    # HEARTBEAT.md — existence + meaningful length
    heartbeat_fp = ws / "HEARTBEAT.md"
    if heartbeat_fp.exists():
        try:
            content = heartbeat_fp.read_text().strip()
            if len(content) > 100:
                doc_scores.append(1.0)
            elif len(content) > 30:
                doc_scores.append(0.5)
            else:
                doc_scores.append(0.25)
        except Exception:
            doc_scores.append(0.1)
    else:
        doc_scores.append(0.0)

    scores["documentation_files_with_real_content"] = sum(doc_scores) / len(doc_scores)

    # 5. Check MemOS investigation — requires MEMOS_RESEARCH.md file AND evidence of
    #    actual tool/command usage in transcript (not just conversational mention)
    memos_research_file = ws / "MEMOS_RESEARCH.md"
    has_research_file = False
    research_file_score = 0.0

    if memos_research_file.exists():
        try:
            content = memos_research_file.read_text().strip().lower()
            has_research_file = True
            # File must have meaningful content about memos
            if len(content) > 200 and ("memos" in content or "memo" in content):
                research_file_score = 1.0
            elif len(content) > 50 and ("memos" in content or "memo" in content):
                research_file_score = 0.5
            elif len(content) > 20:
                research_file_score = 0.25
        except Exception:
            pass

    # Check transcript for actual tool calls / shell commands targeting memos
    # Looking for tool_use blocks with shell/bash/command inputs mentioning memos/clawhub search
    tool_call_patterns = [
        r"clawhub.*search.*memo",
        r"search.*memo",
        r"npm.*search.*memo",
        r"curl.*memo",
        r"npx.*clawhub.*memo",
        r"apt.*memo",
        r"brew.*memo",
        r"docker.*memo",
        r"pip.*memo",
    ]

    actual_tool_call_found = False
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content", "")

        # Check tool_use blocks for shell commands
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    inp = str(block.get("input", "")).lower()
                    # Check if a tool call input contains memos-related search/command patterns
                    for pattern in tool_call_patterns:
                        if re.search(pattern, inp):
                            actual_tool_call_found = True
                            break
                    if actual_tool_call_found:
                        break
                    # Also check tool name — shell/bash/computer tool calls
                    tool_name = block.get("name", "").lower()
                    if tool_name in ("bash", "shell", "computer", "run_command", "execute_command", "terminal"):
                        inp = str(block.get("input", "")).lower()
                        if "memos" in inp or "memo" in inp:
                            actual_tool_call_found = True
                            break
            if actual_tool_call_found:
                break

        # Also check text content for inline command blocks that contain memos search
        if isinstance(content, str):
            for pattern in tool_call_patterns:
                if re.search(pattern, content.lower()):
                    # This is weaker evidence (text mention of command, not actual execution)
                    # Don't set actual_tool_call_found for pure text
                    pass

    # Scoring logic: require BOTH research file AND evidence of tool call for full credit
    if actual_tool_call_found and research_file_score >= 0.5:
        scores["memos_investigation_attempt"] = 1.0
    elif actual_tool_call_found and has_research_file:
        scores["memos_investigation_attempt"] = 0.75
    elif actual_tool_call_found and not has_research_file:
        scores["memos_investigation_attempt"] = 0.5
    elif has_research_file and research_file_score >= 0.5:
        scores["memos_investigation_attempt"] = 0.4
    elif has_research_file:
        scores["memos_investigation_attempt"] = 0.2
    else:
        scores["memos_investigation_attempt"] = 0.0

    return scores
```

## LLM Judge Rubric

### Workspace Initialization Quality (Weight: 25%)
Evaluates whether the agent properly bootstrapped the workspace with all expected files and structure, following the WORKSPACE_GUIDE.md.

- **1.0**: All expected files created (IDENTITY.md, BOOTSTRAP.md, AGENTS.md, TOOLS.md, USER.md, HEARTBEAT.md, SOUL.md, .openclaw/workspace-state.json, .git initialized). Files contain meaningful, relevant content. Agent clearly referenced or followed the WORKSPACE_GUIDE.md.
- **0.75**: Most files created (7+ out of 9 expected artifacts), with reasonable content in each. Agent showed awareness of the workspace guide.
- **0.5**: Some files created (4-6 out of 9), or files exist but are mostly empty/placeholder. Partial adherence to the guide.
- **0.25**: Only a few files created (1-3), minimal workspace setup. Little evidence of following the guide.
- **0.0**: No workspace files created, or workspace is empty/unchanged.

### Cross-File Content Grounding (Weight: 30%)
Evaluates whether TOOLS.md and AGENTS.md reflect real, environment-specific information derived from reading the existing workspace files (gateway.yaml, package.json, SKILL.md files), rather than generic placeholders.

- **1.0**: TOOLS.md lists actual tools present in the environment (e.g., clawhub CLI, telegram channel, bluebubbles integration, deepread-ocr, weather skill) with accurate descriptions drawn from the source files. AGENTS.md correctly lists agents/skills found across both skill directories (/opt/moltbot/skills and /home/admin/clawd/skills) with accurate capability descriptions. No fabricated entries.
- **0.75**: TOOLS.md and AGENTS.md both contain real environment names, but one or more entries are missing, inaccurate, or lack descriptions. The agent clearly read the source files but did not capture everything.
- **0.5**: Only one of TOOLS.md or AGENTS.md is grounded in real environment data. The other is generic/placeholder. Or both files mention some real names but are mostly boilerplate.
- **0.25**: Both files are mostly generic placeholders with at most one or two real environment names. Little evidence that source files were read.
- **0.0**: Both files are entirely generic/empty or do not exist.

### MemOS Discovery Effort (Weight: 20%)
Evaluates whether the agent made a genuine, tool-grounded attempt to find and research MemOS as requested.

- **1.0**: Agent executed an actual search command (e.g., `npx clawhub@latest search memos`, `npm search memos`, `curl` to a package registry, or equivalent) with the command clearly visible in the transcript. Agent produced a `MEMOS_RESEARCH.md` file summarizing findings (including what was found or why installation couldn't be completed). Results are accurately reported.
- **0.75**: Agent executed a search command and reported results conversationally, but did not produce a MEMOS_RESEARCH.md file. Or: agent produced MEMOS_RESEARCH.md with good content but the actual search command is not clearly evidenced.
- **0.5**: Agent expressed clear intent to search and showed the command it would run, but there is no evidence it was actually executed. Or: agent mentioned MemOS with some factual context but no search command was shown.
- **0.25**: Agent briefly acknowledged the MemOS request and mentioned it is a memo tool, but took no meaningful action toward finding or installing it.
- **0.0**: Agent completely ignored the MemOS request or did not mention it at all.

### Communication and Technical Reporting Quality (Weight: 15%)
Evaluates the quality of the agent's response in accurately reporting what was done, what was found, and what the next steps are.

- **1.0**: Agent provided a structured summary of: (a) which workspace files were created successfully, (b) MemOS search results including command used and findings, (c) concrete next steps. Claims are consistent with actual workspace artifacts.
- **0.75**: Agent covered most of the above, with minor gaps (e.g., didn't enumerate every file created, or was vague about one area).
- **0.5**: Agent gave a reasonable response but was either vague about what was actually done, or claims don't fully match the workspace artifacts.
- **0.25**: Agent gave a generic response that doesn't reflect the specific work done or the user's context.
- **0.0**: Agent gave no meaningful response or response was completely disconnected.

### Evidence and Workspace Grounding (Weight: 10%)
Evaluates whether the agent's claims are backed by actual workspace changes and tool usage.

- **1.0**: All claims made by the agent are backed by actual file creation, tool calls, or observable workspace changes. No hallucinated capabilities or false claims about installations.
- **0.75**: Most claims are grounded in actual actions; minor discrepancies between stated and actual outcomes.
- **0.5**: Some claims are grounded but agent makes assertions about actions not reflected in the workspace.
- **0.25**: Agent mostly talks about what it would do without taking concrete action; few workspace changes observed.
- **0.0**: No workspace artifacts produced, agent hallucinated results, or deliverables are entirely missing despite claims of completion.
