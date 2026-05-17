---
id: task_00083_morning_news_digest_skill_creation_and_delivery
name: Morning News Digest Skill Creation and Delivery
category: Communication and Scheduling
subcategory: Messaging and Email Communication
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: config/digest-schedule.json
  dest: config/digest-schedule.json
- source: config/feishu-card-template.json
  dest: config/feishu-card-template.json
- source: config/feishu.json
  dest: config/feishu.json
- source: config/news-sources.yaml
  dest: config/news-sources.yaml
- source: drafts/2026-02-09-evening.md
  dest: drafts/2026-02-09-evening.md
- source: memory/2026-02-09.md
  dest: memory/2026-02-09.md
- source: scripts/fetch-hn-top.sh
  dest: scripts/fetch-hn-top.sh
- source: scripts/market-snapshot.py
  dest: scripts/market-snapshot.py
- source: templates/feishu-doc-structure.json
  dest: templates/feishu-doc-structure.json
- source: templates/morning-news.md
  dest: templates/morning-news.md
---

## Prompt

Morning! I need you to do two things for me:

1. First, create a reusable OpenClaw skill at `skills/morning-news-digest/SKILL.md` that can compile a morning news digest — it should be able to gather headlines from multiple sources (web search, news sites, etc.), organize them by category (domestic politics, international affairs, economy, tech, etc.), and format them into a nice briefing. Think of it like a "morning-news-compiler" skill, similar to how other skills like `beetrade` or `blossom-hire` encapsulate a specific capability with clear instructions. You can reference the news sources already configured in `config/news-sources.yaml` and the message template in `templates/morning-news.md`.

2. Then, actually use that skill to put together today's morning news briefing for me. Send it to me as a Feishu message — keep it concise but cover the major stories across a few categories. Use emoji section headers to make it scannable.

## Expected Behavior

The agent should:

1. **Create a `skills/morning-news-digest/SKILL.md` file** in the workspace that defines a reusable "morning news digest" skill. The file should have:
   - YAML frontmatter with at least `name` and `description` fields
   - Markdown sections describing how to gather news (sources, search strategies)
   - Instructions for categorizing and formatting the digest
   - Reference to or inspired by existing workspace assets: `config/news-sources.yaml` (source list and digest settings), `templates/morning-news.md` (output template), `scripts/fetch-hn-top.sh` (HN fetching), `scripts/market-snapshot.py` (market data)
   - Inspired by existing skills like `beetrade`, `blossom-hire`, etc., which encapsulate a capability with structured instructions

2. **Gather current news** by using available tools such as web search, web fetch, or memory search to collect headlines and summaries from multiple sources. The agent may leverage `config/news-sources.yaml` for the list of recommended sources and `scripts/fetch-hn-top.sh` for Hacker News stories.

3. **Compile a morning news briefing** organized into clearly labeled categories (e.g., domestic politics, international affairs, economy/finance, technology, etc.) with emoji section headers for scannability. The agent may use `templates/morning-news.md` as a structural reference and `scripts/market-snapshot.py` for market index data.

4. **Send the compiled briefing as a Feishu message** to the user (ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa05), formatted as a readable digest with bullet points and category headers. The recipient open_id and Feishu configuration are available in `config/feishu.json`.

The agent should produce both the skill definition file at `skills/morning-news-digest/SKILL.md` and the actual news delivery via Feishu message.

## Grading Criteria

- [ ] `skills/morning-news-digest/SKILL.md` exists in the workspace
- [ ] SKILL.md has valid YAML frontmatter with name and description
- [ ] SKILL.md contains instructional sections for news gathering and formatting
- [ ] Agent sent a Feishu message containing a news digest
- [ ] News digest contains multiple categorized sections
- [ ] News digest uses emoji headers for visual organization

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import re

    scores = {
        "skill_file_exists": 0.0,
        "skill_frontmatter_valid": 0.0,
        "skill_has_instructions": 0.0,
        "message_sent_with_news": 0.0,
    }

    # 1. Check skills/morning-news-digest/SKILL.md exists (canonical path per skill convention)
    skill_path = os.path.join(workspace_path, "skills", "morning-news-digest", "SKILL.md")
    if not os.path.isfile(skill_path):
        # Fallback: walk workspace for any SKILL.md
        found_path = None
        for root, dirs, files in os.walk(workspace_path):
            for f in files:
                if f.upper() == "SKILL.MD":
                    found_path = os.path.join(root, f)
                    break
            if found_path:
                break
        if found_path:
            skill_path = found_path

    if not os.path.isfile(skill_path):
        return scores

    scores["skill_file_exists"] = 1.0

    try:
        with open(skill_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return scores

    # 2. Check YAML frontmatter with name and description
    fm_match = re.search(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if fm_match:
        fm_text = fm_match.group(1)
        has_name = bool(re.search(r"(?i)^name\s*:", fm_text, re.MULTILINE))
        has_desc = bool(re.search(r"(?i)^description\s*:", fm_text, re.MULTILINE))
        if has_name and has_desc:
            scores["skill_frontmatter_valid"] = 1.0
        elif has_name or has_desc:
            scores["skill_frontmatter_valid"] = 0.5

    # 3. Check for instructional content (headings, sections about news gathering/formatting)
    headings = re.findall(r"^#{1,3}\s+.+", content, re.MULTILINE)
    news_keywords = re.findall(
        r"(?i)(news|gather|fetch|search|source|categor|format|digest|headline|brief)",
        content,
    )
    if len(headings) >= 2 and len(news_keywords) >= 3:
        scores["skill_has_instructions"] = 1.0
    elif len(headings) >= 1 and len(news_keywords) >= 1:
        scores["skill_has_instructions"] = 0.5

    # 4. Check transcript for a Feishu message sent with news content
    # Primary path: assistant message in transcript containing formatted news digest
    for event in transcript:
        # Path A: direct assistant message
        if event.get("type") == "message":
            msg = event.get("message", {})
            if msg.get("role") == "assistant":
                raw_content = msg.get("content", "")
                if isinstance(raw_content, str):
                    text = raw_content
                elif isinstance(raw_content, list):
                    text = " ".join(
                        block.get("text", "") for block in raw_content
                        if isinstance(block, dict) and block.get("type") == "text"
                    )
                else:
                    text = ""
                if text:
                    score = _score_news_message(text)
                    if score > scores["message_sent_with_news"]:
                        scores["message_sent_with_news"] = score

        # Path B: tool_use / tool_result events for Feishu send actions
        elif event.get("type") in ("tool_use", "tool_result", "tool_call"):
            # Check tool name suggests Feishu messaging
            tool_name = (
                event.get("name", "")
                or event.get("tool_name", "")
                or event.get("function", {}).get("name", "")
            ).lower()
            if any(k in tool_name for k in ("feishu", "send_message", "im_message", "message_send")):
                # Look for news content in tool input
                raw_input = (
                    event.get("input", "")
                    or event.get("arguments", "")
                    or event.get("function", {}).get("arguments", "")
                )
                text = raw_input if isinstance(raw_input, str) else str(raw_input)
                score = _score_news_message(text)
                if score > scores["message_sent_with_news"]:
                    scores["message_sent_with_news"] = score

        if scores["message_sent_with_news"] >= 1.0:
            break

    return scores


def _score_news_message(text: str) -> float:
    """Score a text string for news digest quality signals."""
    import re
    if not text:
        return 0.0

    has_emoji_headers = bool(re.search(
        r"[\U0001F4CC\U0001F4F0\U0001F30D\U00002B50\U0001F4B0\U0001F4BB"
        r"\U00002600\U0001F4E2\U0001F3E0\U0001F5FA\U0001F4CA\U0001F4A1\U0001F3AC"
        r"\U0001F310\U0001F4C8\U00002601]",
        text
    ))
    has_bullets = text.count("•") >= 2 or text.count("- ") >= 2
    has_bold = text.count("**") >= 2
    section_markers = len(re.findall(
        r"[\U0001F4CC\U0001F4F0\U0001F30D\U00002B50\U0001F4B0\U0001F4BB"
        r"\U00002600\U0001F4E2\U0001F3E0\U0001F5FA\U0001F4CA\U0001F4A1\U0001F3AC"
        r"\U0001F310\U0001F4C8\U00002601].*\*\*",
        text
    ))

    if has_emoji_headers and has_bullets and has_bold and section_markers >= 2:
        return 1.0
    elif has_bullets and (has_emoji_headers or has_bold):
        return 0.7
    elif has_bullets or has_bold:
        return 0.4
    return 0.0
```

## LLM Judge Rubric

### Skill Definition Quality (Weight: 25%)
Evaluates whether the `skills/morning-news-digest/SKILL.md` file is a well-structured, reusable skill definition for compiling morning news digests.

- **1.0**: SKILL.md is placed at `skills/morning-news-digest/SKILL.md`, has proper YAML frontmatter (name, description), multiple instructional sections covering news sources, gathering strategy, categorization, and formatting. Could be reused by another agent session.
- **0.75**: SKILL.md exists at the correct path with frontmatter and reasonable instructions but is missing one key aspect (e.g., no categorization guidance or no source strategy).
- **0.5**: SKILL.md exists (possibly at wrong path) with basic structure but is thin on actionable instructions or missing frontmatter fields.
- **0.25**: SKILL.md exists but is mostly placeholder or boilerplate with little useful content.
- **0.0**: SKILL.md does not exist or is empty.

### News Content Breadth and Accuracy (Weight: 30%)
Evaluates whether the compiled news digest covers multiple topic categories with substantive, plausible headlines.

- **1.0**: Digest covers at least 3 distinct categories (e.g., domestic politics, international, economy, tech) with multiple specific headlines per category that appear to be real current events.
- **0.75**: Covers 2-3 categories with reasonable headlines, though some may lack detail.
- **0.5**: Covers 1-2 categories or headlines are vague and lack specificity.
- **0.25**: Only a single topic or very few generic items that don't constitute a real briefing.
- **0.0**: No news content was produced, or content is completely fabricated without any apparent research effort.

### Formatting and Readability (Weight: 20%)
Evaluates the visual organization and scannability of the news digest message.

- **1.0**: Uses emoji section headers, bold text for key items, bullet points, and clear category separation. Easy to scan quickly.
- **0.75**: Good formatting with most elements present but minor inconsistencies.
- **0.5**: Some formatting effort but missing emoji headers or bullet structure is inconsistent.
- **0.25**: Minimal formatting — mostly plain text wall.
- **0.0**: No formatted output was delivered.

### Evidence and Workspace Grounding (Weight: 25%)
Evaluates whether the agent actually used tools to gather news (web search, web fetch) and produced workspace artifacts as instructed, rather than hallucinating content. Also evaluates whether the agent made use of provided workspace assets (e.g., `config/news-sources.yaml`, `templates/morning-news.md`).

- **1.0**: Transcript shows multiple tool calls (web search, web fetch) to gather news from real sources, `skills/morning-news-digest/SKILL.md` exists on disk, agent referenced or utilized workspace assets (news-sources config, templates, scripts), and the delivered message aligns with gathered information.
- **0.75**: Some tool usage evident and SKILL.md exists at correct path, but connection between gathered data and output is loose, or workspace assets were not leveraged.
- **0.5**: Limited tool usage or SKILL.md is missing/at wrong path/weak, though a news message was sent.
- **0.25**: Minimal evidence of actual research; output appears largely fabricated. SKILL.md missing or empty.
- **0.0**: No workspace artifacts produced, no tool usage for news gathering, or deliverable is completely absent.