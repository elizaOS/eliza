/**
 * Auto-injected brief for opencode sub-agents.
 *
 * Unlike Claude (which lands in \`<workdir>/CLAUDE.md\` via the ClaudeAdapter)
 * and Codex (which lands in \`<workdir>/AGENTS.md\` via the CodexAdapter),
 * opencode is routed through the shell adapter — \`coding-agent-adapters\`
 * has no first-class \`OpencodeAdapter\` yet. So the orchestrator writes
 * \`AGENTS.md\` to the workdir explicitly before spawn (opencode reads
 * AGENTS.md by convention, same as Codex).
 *
 * Keep this in sync with \`CLAUDE_SKILL_ESSENTIALS\` and \`CODEX_SKILL_ESSENTIALS\`
 * — the DECISION protocol, bridge endpoints, and NEVER list are the same
 * cross-adapter contract. Only the tool-list and config-location lines
 * differ per adapter.
 */
export const OPENCODE_SKILL_ESSENTIALS = `Your tool list is opencode's built-in set (\`bash\`, \`read\`, \`write\`, \`edit\`, \`glob\`, \`grep\`, and friends). The model + provider are injected via the \`OPENCODE_CONFIG_CONTENT\` env var by the Eliza runtime before startup — do not run \`opencode auth\` or try to switch provider; the config is correct for this session.

# DECISION protocol

The orchestrator greps your stdout for lines starting with \`DECISION:\`. Use them when you make an architectural choice not covered by the brief, or when reporting a hard limitation. Examples:

\`\`\`
DECISION: chose /api/v1/messages/ over /messages/ to match existing eliza-cloud route prefix.
DECISION: cannot proceed because the requested file lives outside the workspace and reads outside workdir are not allowed.
\`\`\`

ALWAYS-on — just print the line. The orchestrator tails for it.

# What you should NEVER do

- Run \`opencode auth\` or attempt to switch model/provider. The orchestrator injected \`OPENCODE_CONFIG_CONTENT\` with the right credentials and endpoint for this session.
- Say "run this in your terminal" or "execute the following commands yourself" — there is no terminal in your face; you ARE the terminal.
- Ask the human to clarify or provide input — there is no human in your session. Make the best call you can with what you have and surface DECISION lines for non-obvious choices.
- Push to git remotes, write outside your workdir, print secret env values (especially the cerebras / openrouter / OpenAI-compatible API key on \`OPENCODE_CONFIG_CONTENT\`).
- Treat partial information as a blocker — produce the best output you can with what you have.

# Bridge endpoints (parent state, read-only)

When the runtime wires HTTP hooks (variants \`swarm\` and \`repo\`), GET these to query parent state. The literal session-id URLs are written into the per-spawn AGENTS.md you are currently reading — use those directly.

- \`/api/coding-agents/<sessionId>/parent-context\` — agent character, originating room, original task
- \`/api/coding-agents/<sessionId>/memory?q=<query>&limit=<N>\` — recent messages from the originating room
- \`/api/coding-agents/<sessionId>/active-workspaces\` — sibling sub-agents (swarm only)

Auth is the path-embedded session id. Loopback-only, GET-only, read-only.

# Constraints

- Sealed env: only an allowlist of vars is forwarded (PATH, HOME, USER, SHELL, OPENCODE_CONFIG_CONTENT, GITHUB_TOKEN, PARALLAX_SESSION_ID, etc.).
- Workspace-only writes: write only inside your workdir.
- Don't push to git remotes — Eliza handles git push, PR creation, cross-repo coordination.
- Don't print secrets — PTY output is captured. Reference secrets by env-var name.`;
