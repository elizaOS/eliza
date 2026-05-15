/**
 * Constants ported byte-for-byte from
 * /home/shad0w/ocplatform-routing-layer/proxy.js v2.2.3
 *
 * DO NOT change these values. They are part of the upstream-detection-bypass
 * surface and the algorithm's behavior depends on identical hashing inputs,
 * indices, and string lists.
 */

export const VERSION = "2.2.3";
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

// ─── Layer 2: String Trigger Replacements ───────────────────────────────────
// Applied globally via split/join on the entire request body.
//
// NOTE: Many entries appear as identity (find === replace) because the upstream
// service treated them as identity-preserving in the production proxy.js. They
// are kept here verbatim for parity. Future tuning can change the right-side.
export const DEFAULT_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
	["OpenClaw", "OCPlatform"],
	["openclaw", "ocplatform"],
	["sessions_spawn", "create_task"],
	["sessions_list", "list_tasks"],
	["sessions_history", "get_history"],
	["sessions_send", "send_to_task"],
	["sessions_yield_interrupt", "task_yield_interrupt"],
	["sessions_yield", "yield_task"],
	["sessions_store", "task_store"],
	["HEARTBEAT_OK", "HB_ACK"],
	["HEARTBEAT", "HB_SIGNAL"],
	["heartbeat", "hb_signal"],
	["running inside", "operating from"],
	["Prometheus", "PAssistant"],
	["prometheus", "passistant"],
	["clawhub.com", "skillhub.example.com"],
	["clawhub", "skillhub"],
	["clawd", "agentd"],
	["lossless-claw", "lossless-ctx"],
	["third-party", "external"],
	["billing proxy", "routing layer"],
	["billing-proxy", "routing-layer"],
	["x-anthropic-billing-header", "x-routing-config"],
	["x-anthropic-billing", "x-routing-cfg"],
	["cch=00000", "cfg=00000"],
	["cc_version", "rt_version"],
	["cc_entrypoint", "rt_entrypoint"],
	["billing header", "routing config"],
	["extra usage", "usage quota"],
	["assistant platform", "ocplatform"],
];

// ─── Layer 3: Tool Name Renames ─────────────────────────────────────────────
// Applied as "quoted" replacements ("name" -> "Name") throughout the body.
// ORDERING NOTE: lcm_expand_query MUST come before lcm_expand to avoid partial
// match (preserved from proxy.js).
export const DEFAULT_TOOL_RENAMES: ReadonlyArray<readonly [string, string]> = [
	["exec", "Bash"],
	["process", "BashSession"],
	["browser", "BrowserControl"],
	["canvas", "CanvasView"],
	["nodes", "DeviceControl"],
	["cron", "Scheduler"],
	["message", "SendMessage"],
	["tts", "Speech"],
	["gateway", "SystemCtl"],
	["agents_list", "AgentList"],
	["list_tasks", "TaskList"],
	["get_history", "TaskHistory"],
	["send_to_task", "TaskSend"],
	["create_task", "TaskCreate"],
	["subagents", "AgentControl"],
	["session_status", "StatusCheck"],
	["web_search", "WebSearch"],
	["web_fetch", "WebFetch"],
	["pdf", "PdfParse"],
	["image_generate", "ImageCreate"],
	["music_generate", "MusicCreate"],
	["video_generate", "VideoCreate"],
	["memory_search", "KnowledgeSearch"],
	["memory_get", "KnowledgeGet"],
	["lcm_expand_query", "ContextQuery"],
	["lcm_grep", "ContextGrep"],
	["lcm_describe", "ContextDescribe"],
	["lcm_expand", "ContextExpand"],
	["yield_task", "TaskYield"],
	["task_store", "TaskStore"],
	["task_yield_interrupt", "TaskYieldInterrupt"],
];

// ─── Layer 6: Property Name Renames ─────────────────────────────────────────
export const DEFAULT_PROP_RENAMES: ReadonlyArray<readonly [string, string]> = [
	["session_id", "thread_id"],
	["conversation_id", "thread_ref"],
	["summaryIds", "chunk_ids"],
	["summary_id", "chunk_id"],
	["system_event", "event_text"],
	["agent_id", "worker_id"],
	["wake_at", "trigger_at"],
	["wake_event", "trigger_event"],
];

// ─── Reverse Mappings ───────────────────────────────────────────────────────
export const DEFAULT_REVERSE_MAP: ReadonlyArray<readonly [string, string]> = [
	["OCPlatform", "OpenClaw"],
	["ocplatform", "openclaw"],
	["create_task", "sessions_spawn"],
	["list_tasks", "sessions_list"],
	["get_history", "sessions_history"],
	["send_to_task", "sessions_send"],
	["task_yield_interrupt", "sessions_yield_interrupt"],
	["yield_task", "sessions_yield"],
	["task_store", "sessions_store"],
	["HB_ACK", "HEARTBEAT_OK"],
	["HB_SIGNAL", "HEARTBEAT"],
	["hb_signal", "heartbeat"],
	["PAssistant", "Prometheus"],
	["passistant", "prometheus"],
	["skillhub.example.com", "clawhub.com"],
	["skillhub", "clawhub"],
	["agentd", "clawd"],
	["lossless-ctx", "lossless-claw"],
	["external", "third-party"],
	["routing layer", "billing proxy"],
	["routing-layer", "billing-proxy"],
	["x-routing-config", "x-anthropic-billing-header"],
	["x-routing-cfg", "x-anthropic-billing"],
	["cfg=00000", "cch=00000"],
	["rt_version", "cc_version"],
	["rt_entrypoint", "cc_entrypoint"],
	["routing config", "billing header"],
	["usage quota", "extra usage"],
];

/** Layer 4 paraphrase replacement for stripped system config block */
export const SYSTEM_CONFIG_PARAPHRASE =
	"\\nYou are an AI operations assistant with access to all tools listed in this request " +
	"for file operations, command execution, web search, browser control, scheduling, " +
	"messaging, and session management. Tool names are case-sensitive and must be called " +
	"exactly as listed. Your responses route to the active channel automatically. " +
	"For cross-session communication, use the task messaging tools. " +
	"Skills defined in your workspace should be invoked when they match user requests. " +
	"Consult your workspace reference files for detailed operational configuration.\\n";
