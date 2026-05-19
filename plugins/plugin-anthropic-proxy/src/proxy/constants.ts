/**
 * Plugin constants — algorithm parameters + default fingerprint dictionaries.
 *
 * The 7-layer transformation algorithm itself was ported byte-for-byte from
 * Shadow's `openclaw-routing-layer/proxy.js` v2.2.3. The constants in this
 * file split into two groups:
 *
 *   1. **Algorithm parameters** (BILLING_HASH_*, REQUIRED_BETAS, CC_TOOL_STUBS,
 *      CC_VERSION, etc.) — these are upstream-detection-bypass surface and
 *      MUST NOT change. They produce the byte-stable identity that makes the
 *      proxy look like a real Claude Code session to Anthropic.
 *
 *   2. **Fingerprint dictionaries** (DEFAULT_REPLACEMENTS, DEFAULT_TOOL_RENAMES,
 *      DEFAULT_PROP_RENAMES, DEFAULT_REVERSE_MAP, SYSTEM_CONFIG_PARAPHRASE) —
 *      these are *framework-shaped*. v0.2.0 ships eliza defaults derived from
 *      profiling `@elizaos/native-reasoning` outbound calls. Non-eliza users
 *      override via `config.json` (see config.json.example).
 *
 * The OpenClaw-specific dictionary that v0.1.0 inherited from proxy.js was
 * removed in v0.2.0 — it leaked OC-specific tool names like `sessions_spawn`
 * mapping to `TaskCreate` for the wrong reasons.
 */

import {
	ELIZA_PROP_RENAMES,
	ELIZA_REPLACEMENTS,
	ELIZA_REVERSE_MAP,
	ELIZA_SYSTEM_CONFIG_PARAPHRASE,
	ELIZA_TOOL_RENAMES,
} from "./eliza-fingerprint.js";

export const VERSION = "0.2.0";
export const UPSTREAM_HOST = "api.anthropic.com";
export const DEFAULT_PORT = 18801;

/** Claude Code version to emulate (update when new CC versions are released) */
export const CC_VERSION = "2.1.97";

/** Billing fingerprint constants (matches real CC utils/fingerprint.ts) */
export const BILLING_HASH_SALT = "59cf53e54c78";
export const BILLING_HASH_INDICES: readonly number[] = [4, 7, 20];

/** Beta flags required for OAuth + Claude Code features */
export const REQUIRED_BETAS: readonly string[] = [
	"oauth-2025-04-20",
	"claude-code-20250219",
	"interleaved-thinking-2025-05-14",
	"advanced-tool-use-2025-11-20",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"effort-2025-11-24",
	"fast-mode-2026-02-01",
];

/**
 * CC tool stubs — injected into tools array to make the tool set look more
 * like a Claude Code session. The model won't call these (schemas are minimal).
 *
 * NOTE: Stored as raw JSON strings (NOT objects) to match proxy.js exactly
 * which inserts these by string concatenation into the tools array.
 */
export const CC_TOOL_STUBS: readonly string[] = [
	'{"name":"Glob","description":"Find files by pattern","input_schema":{"type":"object","properties":{"pattern":{"type":"string","description":"Glob pattern"}},"required":["pattern"]}}',
	'{"name":"Grep","description":"Search file contents","input_schema":{"type":"object","properties":{"pattern":{"type":"string","description":"Regex pattern"},"path":{"type":"string","description":"Search path"}},"required":["pattern"]}}',
	'{"name":"Agent","description":"Launch a subagent for complex tasks","input_schema":{"type":"object","properties":{"prompt":{"type":"string","description":"Task description"}},"required":["prompt"]}}',
	'{"name":"NotebookEdit","description":"Edit notebook cells","input_schema":{"type":"object","properties":{"notebook_path":{"type":"string"},"cell_index":{"type":"integer"}},"required":["notebook_path"]}}',
	'{"name":"TodoRead","description":"Read current task list","input_schema":{"type":"object","properties":{}}}',
];

// ─── Default Fingerprint Dictionaries (eliza) ──────────────────────────────
//
// These are the dictionaries the AnthropicProxyService boots with when no
// explicit override is supplied. Eliza-shaped by default; bring-your-own via
// `config.json` for any other framework.
//
// See ./eliza-fingerprint.ts for the full enumeration with rationale.

export const DEFAULT_REPLACEMENTS = ELIZA_REPLACEMENTS;
export const DEFAULT_TOOL_RENAMES = ELIZA_TOOL_RENAMES;
export const DEFAULT_PROP_RENAMES = ELIZA_PROP_RENAMES;
export const DEFAULT_REVERSE_MAP = ELIZA_REVERSE_MAP;
export const SYSTEM_CONFIG_PARAPHRASE = ELIZA_SYSTEM_CONFIG_PARAPHRASE;
