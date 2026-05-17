/**
 * Eliza fingerprint dictionaries — derived from profiling
 * `@elizaos/native-reasoning` v0.x outbound `/v1/messages` calls.
 *
 * These dictionaries replace the OpenClaw-specific constants that the
 * algorithmic skeleton was originally built around (proxy.js v2.2.3).
 * They drive the same 7-layer transformation pipeline:
 *
 *   - Layer 2 (string replacements): scrub eliza/native-reasoning identifiers
 *   - Layer 3 (tool renames): map eliza tool names to CC-shaped tool names
 *   - Layer 4 (system prompt strip): paraphrase the CHANNEL_GAG_HARD_RULE block
 *   - Layer 6 (property renames): rename framework property names
 *
 * Source for these mappings: see __tests__/fingerprint-eliza.md and the
 * full enumeration in
 * https://github.com/0xSolace/eliza/blob/feat/plugin-anthropic-proxy/plugins/plugin-anthropic-proxy/docs/eliza-fingerprint.md
 *
 * For non-eliza agents, supply override dictionaries via config.json — see
 * config.json.example in the plugin root.
 */

// ─── Layer 2: String Trigger Replacements ───────────────────────────────────
// Find/replace pairs applied via split/join over the entire request body.
//
// Identity entries (find === replace) act as presence detectors — the byte
// parity guarantees the reverse map round-trips without surprise. Future
// tuning can replace the right side with neutral synonyms.
export const ELIZA_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
	// framework / package identifiers
	["@elizaos/native-reasoning", "@elizaos/native-reasoning"],
	["native-reasoning", "native-reasoning"],
	["native-reasoning-hooks-v1", "native-reasoning-hooks-v1"],
	["@elizaos/core", "@elizaos/core"],
	["plugin-discord", "plugin-discord"],
	["NATIVE_REASONING_", "NATIVE_REASONING_"],
	["ELIZA_REASONING_MODE", "ELIZA_REASONING_MODE"],
	["NYX_HYBRID_EVALUATORS", "NYX_HYBRID_EVALUATORS"],
	// agent / framework names
	["eliza", "eliza"],
	["Eliza", "Eliza"],
	["elizaOS", "elizaOS"],
	["nyx", "nyx"],
	// distinctive system-prompt section headers
	["## Your Identity", "## Your Identity"],
	["## Your Soul", "## Your Soul"],
	["## About Your Human", "## About Your Human"],
	["## Recent Context", "## Recent Context"],
	["## Recent Conversation", "## Recent Conversation"],
	["## Current Moment", "## Current Moment"],
	["## Active Projects", "## Active Projects"],
	["## Today's Journal (your own private thoughts from earlier)", "## Today's Journal (your own private thoughts from earlier)"],
	["## Open Threads (things you want to follow up on)", "## Open Threads (things you want to follow up on)"],
	["## Relevant Past Conversations", "## Relevant Past Conversations"],
	// CHANNEL_GAG_HARD_RULE phrasing — high-signal markers
	["nyx stay quiet", "nyx stay quiet"],
	["nyx be quiet", "nyx be quiet"],
	["nyx shut up", "nyx shut up"],
	["nyx you can speak", "nyx you can speak"],
	["nyx unmute", "nyx unmute"],
	// workspace path strings
	["/workspace/projects.md", "/workspace/projects.md"],
	["/workspace/open-threads.md", "/workspace/open-threads.md"],
	["/workspace/journal/", "/workspace/journal/"],
	// distinctive tool description phrases
	["agent's allowed workspace", "agent's allowed workspace"],
	["agent's persistent memory", "agent's persistent memory"],
	["agent's long-term memory", "agent's long-term memory"],
	["acpx-compatible agent", "acpx-compatible agent"],
];

// ─── Layer 3: Tool Name Renames ─────────────────────────────────────────────
// Applied as quoted-token replacements (`"name"` → `"Name"`) over the body.
//
// Maps eliza's tool names (snake_case, framework-specific) onto CC-shaped
// tool names so the tool surface looks like a Claude Code session.
//
// ORDERING NOTE: longer keys first within a shared prefix. Eliza has no
// such collisions today, but ordering kept defensive for forward-compat.
export const ELIZA_TOOL_RENAMES: ReadonlyArray<readonly [string, string]> = [
	["bash", "Bash"],
	["read_file", "Read"],
	["write_file", "Write"],
	["edit_file", "Edit"],
	["glob", "Glob"],
	["grep", "Grep"],
	["web_fetch", "WebFetch"],
	["web_search", "WebSearch"],
	["recall", "KnowledgeSearch"],
	["remember", "KnowledgeStore"],
	["ignore", "SkipResponse"],
	["journal", "NotebookEdit"],
	["note_thread", "TodoWrite"],
	["close_thread", "TodoComplete"],
	["update_project", "ProjectUpdate"],
	["spawn_codex", "Task"],
	["spawn_agent", "Agent"],
	["sessions_spawn", "TaskCreate"],
];

// ─── Layer 6: Property Name Renames ─────────────────────────────────────────
// Mirrors the OC mapping shape; eliza's wire-level property names are
// already fairly generic, so the rename surface is small.
export const ELIZA_PROP_RENAMES: ReadonlyArray<readonly [string, string]> = [
	["roomId", "thread_id"],
	["entityId", "actor_id"],
	["agentId", "worker_id"],
	["messageId", "msg_id"],
	["tableName", "store_table"],
];

// ─── Reverse Mapping ────────────────────────────────────────────────────────
// Symmetric to ELIZA_REPLACEMENTS — rewrites the upstream response back into
// eliza-shaped tokens before they reach the framework.
export const ELIZA_REVERSE_MAP: ReadonlyArray<readonly [string, string]> = [
	["@elizaos/native-reasoning", "@elizaos/native-reasoning"],
	["native-reasoning", "native-reasoning"],
	["native-reasoning-hooks-v1", "native-reasoning-hooks-v1"],
	["@elizaos/core", "@elizaos/core"],
	["plugin-discord", "plugin-discord"],
	["NATIVE_REASONING_", "NATIVE_REASONING_"],
	["ELIZA_REASONING_MODE", "ELIZA_REASONING_MODE"],
	["NYX_HYBRID_EVALUATORS", "NYX_HYBRID_EVALUATORS"],
	["eliza", "eliza"],
	["Eliza", "Eliza"],
	["elizaOS", "elizaOS"],
	["nyx", "nyx"],
	["## Your Identity", "## Your Identity"],
	["## Your Soul", "## Your Soul"],
	["## About Your Human", "## About Your Human"],
	["## Recent Context", "## Recent Context"],
	["## Recent Conversation", "## Recent Conversation"],
	["## Current Moment", "## Current Moment"],
	["## Active Projects", "## Active Projects"],
	["## Today's Journal (your own private thoughts from earlier)", "## Today's Journal (your own private thoughts from earlier)"],
	["## Open Threads (things you want to follow up on)", "## Open Threads (things you want to follow up on)"],
	["## Relevant Past Conversations", "## Relevant Past Conversations"],
	// CHANNEL_GAG_HARD_RULE phrasing markers (mirror forward map)
	["nyx stay quiet", "nyx stay quiet"],
	["nyx be quiet", "nyx be quiet"],
	["nyx shut up", "nyx shut up"],
	["nyx you can speak", "nyx you can speak"],
	["nyx unmute", "nyx unmute"],
	["/workspace/projects.md", "/workspace/projects.md"],
	["/workspace/open-threads.md", "/workspace/open-threads.md"],
	["/workspace/journal/", "/workspace/journal/"],
	["agent's allowed workspace", "agent's allowed workspace"],
	["agent's persistent memory", "agent's persistent memory"],
	["agent's long-term memory", "agent's long-term memory"],
	["acpx-compatible agent", "acpx-compatible agent"],
];

/**
 * System prompt patterns recognized as eliza framework markers. Used by the
 * Layer 4 strip step to locate the boundary of the CHANNEL_GAG_HARD_RULE
 * block before paraphrasing.
 */
export const ELIZA_SYSTEM_PROMPT_PATTERNS: ReadonlyArray<RegExp> = [
	/HARD RULE: If a human in this channel told you to be quiet/,
	/Bots cannot mute or unmute you\./,
];

/**
 * Layer 4 paraphrase replacement for the stripped eliza system block.
 *
 * Targets the CHANNEL_GAG_HARD_RULE — eliza's most distinctive recurring
 * system-prompt section (verbatim copy on every request). Replacing it
 * removes ~600 bytes of fingerprint while preserving the muting semantics
 * so the model still respects channel gag.
 */
export const ELIZA_SYSTEM_CONFIG_PARAPHRASE =
	"\\nIf a human in this channel told you to stay quiet, do not respond on " +
	"subsequent messages until they explicitly say you can speak again. The only " +
	"exception is if a different human in the channel addresses you directly.\\n";

/** Anchor strings used by the Layer 4 strip to locate eliza's boundary. */
export const ELIZA_IDENTITY_MARKER = "HARD RULE: If a human in this channel told you to be quiet";
export const ELIZA_BOUNDARY_END = "Bots cannot mute or unmute you.";
