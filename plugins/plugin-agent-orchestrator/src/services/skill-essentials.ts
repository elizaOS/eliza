/**
 * Auto-injected subset of `assets/claude-code-skills/eliza-runtime/SKILL.md`
 * that ships verbatim in the workspace-lock brief for claude sub-agents.
 *
 * Why a separate constant (and not just a Read of SKILL.md at runtime):
 * sub-agents on the Claude.ai consumer-tier OAuth do not have the `Skill`
 * tool, so the skill auto-load mechanism is unavailable to them. Inlining
 * the must-have sections into the spawn brief gives them the operating
 * manual upfront with zero file I/O.
 *
 * Keep this in sync with SKILL.md: when you edit one, edit both. SKILL.md
 * remains the canonical / extended manual (spawn-variants table, helper
 * scripts, references). This constant is the always-injected minimum.
 */
export const CLAUDE_SKILL_ESSENTIALS = `Tool availability varies by Claude Code build and account tier — enumerate your actual tools (read \`.claude/settings.json\`'s \`permissions.allow\`, or use \`ToolSearch\` if present) before deciding you can't do a thing.

# DECISION protocol

The orchestrator greps your stdout for lines starting with \`DECISION:\`. Use them when you make an architectural choice not covered by the brief, or when reporting a hard limitation. Examples:

\`\`\`
DECISION: chose /api/v1/messages/ over /messages/ to match existing eliza-cloud route prefix.
DECISION: cannot run shell commands — this session has Read/Grep/Glob but no Bash, Monitor, or run_shell_command. Reported what I could find statically.
\`\`\`

ALWAYS-on, no shell tool required — just print the line.

# What you should NEVER do

- Refuse a task as "no shell available" without first enumerating your actual tool list (settings.json + ToolSearch). Different tiers ship different shell tools — \`Bash\`, \`Monitor\`, \`run_shell_command\` — at least one is usually present.
- Say "use the \`!\` prefix" or "run this in your terminal" — there is no terminal in your face.
- Ask the human to clarify or provide input — there is no human in your session.
- Push to remotes, write outside workdir, print env tokens.
- Treat partial information as a blocker — produce the best output you can with what you have.

# Bridge endpoints (parent state, read-only)

When HTTP hooks are wired (variants \`swarm\` and \`repo\`), GET these to query parent state:
- \`http://localhost:\${ELIZA_HOOK_PORT:-2138}/api/coding-agents/$PARALLAX_SESSION_ID/parent-context\` — agent character, originating room, original task
- \`.../memory?q=<query>&limit=<N>\` — recent messages from the originating room
- \`.../active-workspaces\` — sibling sub-agents (swarm only)

Auth is the path-embedded session id. Loopback-only, GET-only, read-only.

# Constraints

- Sealed env: only an allowlist of vars is forwarded (PATH, HOME, USER, SHELL, ANTHROPIC_MODEL, GITHUB_TOKEN, PARALLAX_SESSION_ID, ELIZA_HOOK_PORT, etc.).
- Workspace-only writes: write only inside your workdir.
- Don't push to git remotes — Eliza handles git push, PR creation, cross-repo coordination.
- Don't print secrets — PTY output is captured. Reference secrets by env-var name.

For deeper context (spawn-variants table, helper scripts, references) see \`~/.claude/skills/eliza-runtime/SKILL.md\`.`;
