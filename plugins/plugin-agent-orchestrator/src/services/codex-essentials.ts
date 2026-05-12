/**
 * Auto-injected brief for codex sub-agents. Lands in `<workdir>/AGENTS.md`
 * via the `coding-agent-adapters` CodexAdapter.memoryFilePath ("AGENTS.md")
 * route, alongside the workspace lock and parent runtime bridge.
 *
 * Mirrors `CLAUDE_SKILL_ESSENTIALS` in shape so a parent runtime change
 * (new bridge endpoint, new DECISION semantics) lands in both via a
 * single audit pass. Differences are tool-list + config-location only.
 *
 * Codex reads AGENTS.md from cwd as project rules — same convention every
 * recent OpenAI-CLI-style coding agent uses (opencode follows it too).
 */
export const CODEX_SKILL_ESSENTIALS = `Your tool list is the OpenAI Codex runtime's built-in set (\`exec_command\`, \`apply_patch\`, \`read_file\`, \`write_file\`, and friends). The approval policy and sandbox mode are injected via \`$CODEX_HOME/config.toml\` by the Eliza runtime before startup — do not re-prompt to change them; if a tool blocks, the policy explicitly forbade it.

# DECISION protocol

The orchestrator greps your stdout for lines starting with \`DECISION:\`. Use them when you make an architectural choice not covered by the brief, or when reporting a hard limitation. Examples:

\`\`\`
DECISION: chose /api/v1/messages/ over /messages/ to match existing eliza-cloud route prefix.
DECISION: cannot proceed because the sandbox blocked network egress and the task requires curl.
\`\`\`

ALWAYS-on — just print the line. The orchestrator tails for it.

# What you should NEVER do

- Re-prompt for approval or sandbox mode changes. The runtime chose them on purpose for this session.
- Say "run this in your terminal" or "execute the following commands yourself" — there is no terminal in your face; you ARE the terminal.
- Ask the human to clarify or provide input — there is no human in your session. Make the best call you can with what you have and surface DECISION lines for non-obvious choices.
- Push to git remotes, write outside your workdir, print secret env values.
- Treat partial information as a blocker — produce the best output you can with what you have.

# Bridge endpoints (parent state, read-only)

When the runtime wires HTTP hooks (variants \`swarm\` and \`repo\`), GET these to query parent state. The literal session-id URLs are written into the per-spawn AGENTS.md you are currently reading — use those directly.

- \`/api/coding-agents/<sessionId>/parent-context\` — agent character, originating room, original task
- \`/api/coding-agents/<sessionId>/memory?q=<query>&limit=<N>\` — recent messages from the originating room
- \`/api/coding-agents/<sessionId>/active-workspaces\` — sibling sub-agents (swarm only)

Auth is the path-embedded session id. Loopback-only, GET-only, read-only.

# Constraints

- Sealed env: only an allowlist of vars is forwarded (PATH, HOME, USER, SHELL, OPENAI_MODEL, CODEX_HOME, GITHUB_TOKEN, PARALLAX_SESSION_ID, etc.).
- Workspace-only writes: write only inside your workdir.
- Don't push to git remotes — Eliza handles git push, PR creation, cross-repo coordination.
- Don't print secrets — PTY output is captured. Reference secrets by env-var name.`;
