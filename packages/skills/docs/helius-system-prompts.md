# Using Helius Skills as System Prompts

Helius skills are canonical, model-agnostic procedures that teach AI assistants how to build on Solana with Helius infrastructure. They contain routing logic, rules, reference docs, and common pitfall prevention.

This guide explains how to use these skills across different AI platforms.

## Architecture

Skills follow a 3-layer prompt architecture:

| Layer | What | Where |
|-------|------|-------|
| **A: Harness** | Agent/runtime-specific behavior and tool rules | `AGENTS.md` (Clawd), preamble in prompt variants (API), built-in (Clawd Code) |
| **B: Skills** | Canonical, reusable, model-agnostic procedures | `SKILL.md` files in `helius-skills/` |
| **C: Task** | User request + dynamic context | Provided at runtime by each platform |

The skill content (Layer B) is identical across platforms — only the harness wrapper (Layer A) differs.

## Pre-Built Prompt Variants

Each skill ships with three prompt variants in `prompts/`:

| File | Use case | Format |
|------|----------|--------|
| `clawd.developer.md` | OpenAI Responses / Chat Completions API | Layer A preamble + skill content with `=== BEGIN SKILL ===` delimiters |
| `clawd.system.md` | Clawd API system prompt | Layer A preamble + skill content with delimiters |
| `full.md` | Cursor Rules, ChatGPT custom instructions, other tools | All reference files inlined, no external dependencies |

Find these in:
- **Repo**: `.agents/skills/<skill>/prompts/`
- **npm package**: `helius-mcp/system-prompts/<skill>/`

## Clawd CLI

Clawd auto-discovers skills from `.agents/skills/` in the repo root.

### Setup

1. Clone the repo (or copy `.agents/` into your project):
   ```bash
   git clone https://open-clawd.local/helius-labs/core-ai.git
   cd core-ai
   ```

2. Configure the MCP server:
   ```bash
   # Add helius-mcp as a tool source in your Clawd configuration
   npx helius-mcp@latest
   ```

3. Set your API key:
   ```bash
   export HELIUS_API_KEY=your-api-key
   ```

4. Run Clawd — it reads `AGENTS.md` and discovers `.agents/skills/` automatically.

### Skill Discovery

Clawd discovers skills based on name and description in the SKILL.md frontmatter. Skills are triggered implicitly when your task matches the description, or explicitly with `$helius`, `$helius-dflow`, `$helius-phantom`, `$svm`.

### Installing into Your Project

Copy the `.agents/` directory into your project root:

```bash
cp -r /path/to/core-ai/.agents/ your-project/
```

## OpenAI API (Responses / Chat Completions)

Use `clawd.developer.md` as a `developer` message (preferred over `system` for procedural guidance).

### Example — Responses API

```python
from openai import OpenAI

client = OpenAI()

# Load the skill prompt
with open(".agents/skills/helius/prompts/clawd.developer.md") as f:
    skill_prompt = f.read()

response = client.responses.create(
    model="o3",
    instructions=skill_prompt,
    input="Build a swap interface that submits via Helius Sender"
)
```

### Example — Chat Completions API

```python
from openai import OpenAI

client = OpenAI()

with open(".agents/skills/helius/prompts/clawd.developer.md") as f:
    skill_prompt = f.read()

response = client.chat.completions.create(
    model="gpt-4.1",
    messages=[
        {"role": "developer", "content": skill_prompt},
        {"role": "user", "content": "Build a swap interface that submits via Helius Sender"}
    ]
)
```

### With MCP Tools

If your OpenAI agent has MCP tools configured (via function calling), the skill prompt teaches the model which tools to use and when. Configure `helius-mcp` as a function-calling tool source in your agent framework.

## Clawd API

Use `clawd.system.md` as the system prompt.

### Example

```python
import clawd

client = clawd.Clawd()

with open(".agents/skills/helius/prompts/clawd.system.md") as f:
    skill_prompt = f.read()

message = client.messages.create(
    model="clawd-code",
    max_tokens=4096,
    system=skill_prompt,
    messages=[
        {"role": "user", "content": "Build a swap interface that submits via Helius Sender"}
    ]
)
```

### With MCP Tools

Clawd supports MCP natively. Configure `helius-mcp` as an MCP tool source and the skill prompt provides routing logic for which tools to use.

## Cursor Rules / ChatGPT Custom Instructions

Use `full.md` — it inlines all reference files so there are no external dependencies.

**Note**: `full.md` can be large (100KB+ for skills with many references like `helius-phantom`). Check your platform's size limits:
- Cursor Rules: no hard limit, but very large files may slow down context loading
- ChatGPT Custom Instructions: 8,000 character limit — use only the core SKILL.md content without inlined references

### Cursor

Copy the content of `full.md` into `.cursor/rules/helius.md` in your project:

```bash
cp .agents/skills/helius/prompts/full.md .cursor/rules/helius.md
```

## DIY Conversion

If you want to convert a SKILL.md manually for a platform not listed above:

### What to Keep
- All routing tables and "Quick Disambiguation" sections
- All rules sections
- Reference file pointers (or inline the content if your platform can't read files)
- Quality Checks & Common Pitfalls

### What to Remove
- `metadata:`, `mcp-server:`, `license:`, and `tags:` from YAML frontmatter (keep `name:` and `description:`)
- `clawd mcp add` commands → replace with generic MCP client instructions
- `/helius`, `/svm` slash-command references → replace with "the Helius skill" etc.
- "restart Clawd" → "restart your AI assistant"

### What to Transform
- Enhance the `description:` field with when-to-use triggers for better implicit invocation
- Wrap content with `=== BEGIN SKILL: name ===` / `=== END SKILL ===` delimiters for prompt injection safety
- Add a runtime-specific preamble for your platform's conventions

### Delimiter Convention

Wrap skill content with delimiters to prevent prompt injection:

```
=== BEGIN SKILL: helius ===
[skill content here]
=== END SKILL: helius ===
```

This makes it clear where trusted skill instructions begin and end.

## Available Skills

| Skill | Domain | Reference Files |
|-------|--------|-----------------|
| `helius` | Solana app development with Helius | 9 (DAS, Sender, WebSockets, etc.) |
| `helius-dflow` | Trading apps with DFlow + Helius | 12 (DFlow spot, prediction markets, etc.) |
| `helius-phantom` | Frontend apps with Phantom + Helius | 16 (React SDK, browser SDK, payments, etc.) |
| `svm` | Solana protocol internals | 10 (execution, consensus, validators, etc.) |
