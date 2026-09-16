import * as fs from "node:fs";
import { hostname } from "node:os";
import * as pathMod from "node:path";
/**
 * elizaOS's standard structured logger, built on Adze. Exposes the `Logger`
 * interface and the `createLogger` factory (plus the default `logger` /
 * `elizaLogger` singletons) as a Pino-shaped API extended with custom
 * `success`/`progress` levels. Redacts sensitive fields with a deep-walk
 * redactor that deep-clones log context objects (callers keep their live
 * objects unmutated) and masks every value under a credential-named key at any
 * nesting depth, matched case-insensitively. Binary payloads (Buffer, typed
 * arrays, DataView, ArrayBuffer) collapse to a size-only marker so raw bytes
 * never reach a sink under a neutral key. String values — object properties,
 * headline messages, and Error message/stack — are additionally scrubbed for
 * credential shapes (API keys, Bearer tokens, URI userinfo, PEM blocks) with
 * the pattern library mirrored from `@elizaos/core`'s security/redact.ts,
 * because this process's ring buffer, file sinks, and WS stream have no
 * downstream scrubber. Keeps
 * an in-memory ring buffer with real-time listeners for WebSocket streaming,
 * and lazily opens optional file sinks (`output.log`, `prompts.log`,
 * `chat.log`, all 0600) with prompt/response/chat instrumentation helpers.
 * Node logging is synchronously available; file sinks open lazily.
 */
// Leaf-only test access; excluded from the public runtime barrel.
export const __loggerTestHooks = {
	stripAnsi: (str: string): string => stripAnsi(str),
};

import {
	REDACTION_FAILED_VALUE,
	redactLogValue,
	redactSensitiveLogText,
	redactTrailingArgs,
} from "@elizaos/shared/log-redaction";
import adze, {
	type ConsoleStyle,
	type LevelConfiguration,
	type Method,
	setup,
	type UserConfiguration,
} from "adze";
import type Log from "adze/dist/log.js";

const getEnvironmentVar = (
	key: string,
	fallback?: string,
): string | undefined => process.env[key] ?? fallback;

/**
 * Interface for Adze sealed logger with known methods
 */
interface AdzeLogMethods {
	alert(...args: unknown[]): void;
	error(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	info(...args: unknown[]): void;
	fail(...args: unknown[]): void;
	success(...args: unknown[]): void;
	log(...args: unknown[]): void;
	debug(...args: unknown[]): void;
	verbose(...args: unknown[]): void;
}

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Log function signature matching Pino's API for compatibility
 */
type LogFn = (
	obj: Record<string, unknown> | string | Error,
	msg?: string,
	...args: unknown[]
) => void;

/**
 * Logger interface - elizaOS standard logger API
 */
export interface Logger {
	level: string;
	trace: LogFn;
	debug: LogFn;
	info: LogFn;
	warn: LogFn;
	error: LogFn;
	fatal: LogFn;
	success: LogFn;
	progress: LogFn;
	log: LogFn;
	clear: () => void;
	child: (bindings: Record<string, unknown>) => Logger;
}

/**
 * Configuration for logger creation
 */
export interface LoggerBindings extends Record<string, unknown> {
	level?: string;
	namespace?: string;
	namespaces?: string[];
	/**
	 * Retention cap for the process-wide in-memory ring buffer backing
	 * `recentLogs()` and WebSocket log streaming. A positive value resizes the
	 * shared buffer in place, preserving already-captured history; raising the
	 * cap keeps prior entries and lowering it trims the oldest. Non-positive or
	 * non-finite values are ignored, leaving the current cap (default 100)
	 * unchanged. Constructing a logger never clears the shared buffer.
	 */
	maxMemoryLogs?: number;
}

/**
 * Log entry structure for in-memory storage and streaming
 */
export interface LogEntry {
	time: number;
	level?: number;
	msg: string;
	agentName?: string;
	agentId?: string;
	[key: string]: string | number | boolean | null | undefined;
}

/**
 * Log listener callback type for real-time log streaming
 */
export type LogListener = (entry: LogEntry) => void;

// Global log listeners for streaming
const logListeners: Set<LogListener> = new Set();
const warnedLogListeners: WeakSet<LogListener> = new WeakSet();

/**
 * Add a listener for real-time log entries (used for WebSocket streaming)
 * @param listener - Callback function to receive log entries
 * @returns Function to remove the listener
 */
export function addLogListener(listener: LogListener): () => void {
	if (!logListeners.has(listener)) {
		warnedLogListeners.delete(listener);
		logListeners.add(listener);
	}
	return () => logListeners.delete(listener);
}

/**
 * Remove a log listener
 * @param listener - The listener to remove
 */
export function removeLogListener(listener: LogListener): void {
	logListeners.delete(listener);
}

/**
 * In-memory destination for recent logs
 */
interface InMemoryDestination {
	write: (entry: LogEntry) => void;
	clear: () => void;
	recentLogs: () => string;
	/**
	 * Resize the ring buffer's retention cap in place. Raising the cap keeps
	 * existing entries; lowering it trims the oldest entries from the front so
	 * at most `maxLogs` remain. Only a finite safe integer `>= 1` is honored;
	 * fractional, non-finite, unsafe-integer, and non-positive values are ignored
	 * so a bad binding cannot silently disable or wipe retention. Never clears
	 * the buffer — the buffer is shared process-wide, so prior history is
	 * preserved.
	 */
	setMaxLogs: (maxLogs: number) => void;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Log level priorities for filtering
 */
const LOG_LEVEL_PRIORITY: Record<string, number> = {
	trace: 10,
	verbose: 10,
	debug: 20,
	success: 27,
	progress: 28,
	log: 29,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
	alert: 60,
};

/**
 * Reverse mapping from numeric level to preferred level name
 * When multiple level names have the same numeric value, we prioritize the most semantic one
 */
const LEVEL_TO_NAME: Record<number, string> = {
	10: "trace", // prefer 'trace' over 'verbose'
	20: "debug",
	27: "success",
	28: "progress",
	29: "log",
	30: "info",
	40: "warn",
	50: "error",
	60: "fatal", // prefer 'fatal' over 'alert'
};

/**
 * Check if a message should be logged based on current level
 */
function shouldLog(messageLevel: string, currentLevel: string): boolean {
	const messagePriority = LOG_LEVEL_PRIORITY[messageLevel.toLowerCase()] || 30;
	const currentPriority = LOG_LEVEL_PRIORITY[currentLevel.toLowerCase()] || 30;
	return messagePriority >= currentPriority;
}

/**
 * Safe JSON stringify that handles circular references
 */
function safeStringify(obj: unknown): string {
	try {
		const seen = new WeakSet();
		return JSON.stringify(obj, (_, value) => {
			if (typeof value === "object" && value !== null) {
				if (seen.has(value)) return "[Circular]";
				seen.add(value);
			}
			return value;
		});
	} catch {
		return String(obj);
	}
}

/**
 * Parse boolean from text string
 */
function parseBooleanFromText(value: string | undefined | null): boolean {
	if (!value) return false;
	const normalized = value.toLowerCase().trim();
	return (
		normalized === "true" ||
		normalized === "1" ||
		normalized === "yes" ||
		normalized === "on"
	);
}

/**
 * Format a value for display in pretty log extras
 */
function formatExtraValue(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (value instanceof Error) return value.message;
	return safeStringify(value);
}

/**
 * Format a log entry in compact pretty format
 * Format: [src] message (key=val, key=val)
 *
 * agentId/agentName are NOT displayed in pretty mode because:
 * - Loggers with namespace already show an agent-prefixed tag (via Adze)
 * - These fields ARE still included in JSON mode for filtering/monitoring
 */
function formatPrettyLog(
	context: Record<string, unknown>,
	message: string,
	isJsonMode: boolean,
): string {
	// In JSON mode, don't format - return message as-is
	if (isJsonMode) {
		return message;
	}

	const src = context.src as string | undefined;

	// Build prefix: [SRC] in uppercase
	const srcPart = src ? `[${src.toUpperCase()}] ` : "";

	// Build extras: (key=val, key=val)
	// Exclude: src (already in prefix), agentId/agentName (shown via Adze namespace tag)
	const excludeKeys = ["src", "agentId", "agentName"];
	const extraPairs: string[] = [];

	for (const [key, value] of Object.entries(context)) {
		if (excludeKeys.includes(key)) continue;
		if (value === undefined) continue;
		extraPairs.push(`${key}=${formatExtraValue(value)}`);
	}

	const extrasPart = extraPairs.length > 0 ? ` (${extraPairs.join(", ")})` : "";

	return `${srcPart}${message}${extrasPart}`;
}

// ============================================================================
// Configuration
// ============================================================================

// Log level configuration
const DEFAULT_LOG_LEVEL = "info";
const effectiveLogLevel = getEnvironmentVar("LOG_LEVEL") || DEFAULT_LOG_LEVEL;

// Custom log levels mapping (elizaOS to Adze)
// These are for our internal shouldLog function, not Adze's levels
export const customLevels: Record<string, number> = {
	fatal: 60,
	error: 50,
	warn: 40,
	info: 30,
	log: 29,
	progress: 28,
	success: 27,
	debug: 20,
	trace: 10,
};

// Configuration flags
const raw = parseBooleanFromText(getEnvironmentVar("LOG_JSON_FORMAT"));
const showTimestamps = parseBooleanFromText(
	getEnvironmentVar("LOG_TIMESTAMPS") ?? "true",
);

// A Worker isolate cannot generate randomness during module evaluation. Node
// processes already have a stable per-process discriminator; edge hosts should
// inject SERVER_ID when they need one more specific than the runtime label.
const serverId =
	getEnvironmentVar("SERVER_ID") ||
	(typeof process !== "undefined" && process.pid
		? `process-${process.pid}`
		: "edge-runtime");

// ============================================================================
// Sensitive-data redaction
// ============================================================================

// ============================================================================
// File Log Output
// ============================================================================

/**
 * File logging - lazy-initialized on first write to avoid module-init timing issues.
 * Enable with LOG_FILE=true/1 (writes output.log, prompts.log, and chat.log in
 * cwd) or LOG_FILE=/path/to/file.log.
 * Disabled by default.
 */
let _fileLogState: "pending" | "active" | "disabled" = "pending";
let _fileLogFd: number | null = null;
// One-shot guard so a persistent file-write failure surfaces exactly once on
// stderr instead of being swallowed forever by the catch in writeLogEntryToFile
// (#16356: an invalid stripAnsi regex threw on every write and output.log
// silently stayed empty for the sink's whole lifetime).
let _fileLogWriteErrorWarned = false;
let _promptLogFd: number | null = null;
let _chatLogFd: number | null = null;
let _promptLogCounter = 0;

/**
 * Strip ANSI escape codes from a string for plain-text logging.
 * Uses RegExp constructor to avoid control-character-in-regex lint.
 */
function stripAnsi(str: string): string {
	const ESC = "\x1b";
	const BEL = "\x07";
	const re = new RegExp(
		`${ESC}(?:\\[[\\x20-\\x3F]*[\\x40-\\x7E]|\\].*?(?:${BEL}|${ESC}\\\\|\\(B))`,
		"g",
	);
	return str.replace(re, "");
}

/**
 * Open a log sink for appending with owner-only permissions. The `0o600` mode
 * only applies when the file is first created, so fchmod heals files left
 * world-readable by older builds. Prompt and chat logs routinely contain
 * user-pasted secrets, so the sinks must never be group/other-readable.
 */
function openLogFilePrivate(
	fs: typeof import("node:fs"),
	path: string,
): number {
	const fd = fs.openSync(path, "a", 0o600);
	try {
		fs.fchmodSync(fd, 0o600);
	} catch {
		// error-policy:J6 best-effort permission heal on an already-open sink;
		// platforms without POSIX chmod semantics keep the creation-time mode.
	}
	return fd;
}

/**
 * Lazily open the log files on the first write.
 * Returns true if the files are ready for writing.
 */
function ensureFileLog(): boolean {
	if (_fileLogState === "active") return true;
	if (_fileLogState === "disabled") return false;

	_fileLogState = "disabled";
	try {
		const logFileEnv = process.env.LOG_FILE;
		if (
			!logFileEnv ||
			logFileEnv.trim() === "" ||
			logFileEnv.trim() === "0" ||
			logFileEnv.trim().toLowerCase() === "false"
		) {
			return false;
		}

		const isBooleanFlag = ["true", "1", "yes", "on"].includes(
			logFileEnv.trim().toLowerCase(),
		);
		const logFilePath = isBooleanFlag
			? pathMod.join(process.cwd(), "output.log")
			: logFileEnv.trim();
		const logDir = pathMod.dirname(
			isBooleanFlag ? pathMod.join(process.cwd(), "output.log") : logFilePath,
		);

		// Ensure log directory exists
		fs.mkdirSync(logDir, { recursive: true });

		const promptLogPath = pathMod.join(logDir, "prompts.log");
		const chatLogPath = pathMod.join(logDir, "chat.log");

		_fileLogFd = openLogFilePrivate(fs, logFilePath);
		_promptLogFd = openLogFilePrivate(fs, promptLogPath);
		_chatLogFd = openLogFilePrivate(fs, chatLogPath);
		_fileLogState = "active";

		process.on("exit", () => {
			if (_fileLogFd !== null) {
				try {
					fs.closeSync(_fileLogFd);
				} catch {
					// error-policy:J6 best-effort fd close on process exit.
				}
				_fileLogFd = null;
			}
			if (_promptLogFd !== null) {
				try {
					fs.closeSync(_promptLogFd);
				} catch {
					// error-policy:J6 best-effort fd close on process exit.
				}
				_promptLogFd = null;
			}
			if (_chatLogFd !== null) {
				try {
					fs.closeSync(_chatLogFd);
				} catch {
					// error-policy:J6 best-effort fd close on process exit.
				}
				_chatLogFd = null;
			}
		});

		return true;
	} catch {
		// error-policy:J7 ensureFileLog sets up the logger's own optional file
		// sink; the logger cannot report a failure to initialize itself through
		// itself, so a failed setup degrades to no file logging (returns false).
		return false;
	}
}

/**
 * Write a formatted log entry to the output file.
 * Skips unset LOG_FILE or a failed file open.
 */
function writeLogEntryToFile(entry: LogEntry): void {
	if (!ensureFileLog()) return;
	try {
		const fd = _fileLogFd;
		if (fd === null) return;
		const timestamp = new Date(entry.time).toISOString();
		const levelStr = LEVEL_TO_NAME[entry.level ?? 30] || "info";
		const line = `${timestamp} [${levelStr.toUpperCase().padEnd(8)}] ${stripAnsi(entry.msg)}\n`;
		fs.writeSync(fd, line);
	} catch (error) {
		// A persistent write failure (e.g. #16356's invalid regex, which threw on
		// every call) must not stay invisible for the sink's whole lifetime — go
		// straight to stderr once, bypassing the logger that is itself failing.
		if (!_fileLogWriteErrorWarned) {
			_fileLogWriteErrorWarned = true;
			console.error(
				`[logger] failed to write to the log file; further errors are suppressed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
}

// ============================================================================
// Prompt instrumentation (prompts.log)
// ============================================================================

export interface PromptLogMetadata {
	agentName?: string;
	agentId?: string;
	runId?: string;
	provider?: string;
	caller?: string;
	[key: string]: unknown;
}

export interface ResponseLogMetadata {
	agentName?: string;
	agentId?: string;
	runId?: string;
	provider?: string;
	duration?: number;
	promptSlug?: string;
	[key: string]: unknown;
}

function promptSlug(
	counter: number,
	agentName: string,
	modelType: string,
): string {
	return `#${String(counter).padStart(4, "0")}/${agentName}/${modelType}`;
}

function writeToPromptLog(
	slug: string,
	kind: "PROMPT" | "RESPONSE",
	modelType: string,
	body: string,
	metadata?: Record<string, unknown>,
): void {
	if (!ensureFileLog() || _promptLogFd === null) return;
	try {
		const sep = "=".repeat(80);
		let header = `${sep}\n ${slug}  ${kind}: ${modelType} (${body.length} chars)\n`;
		header += ` ${new Date().toISOString()}\n`;
		if (metadata) {
			header += ` ${JSON.stringify(metadata, null, 2)}\n`;
		}
		header += `${sep}\n`;
		fs.writeSync(_promptLogFd, header);
		fs.writeSync(_promptLogFd, body);
		fs.writeSync(_promptLogFd, `\n${sep}\n\n`);
	} catch {
		// Silent fail
	}
}

/**
 * Log a prompt to prompts.log. Returns the slug callers can pass as
 * `metadata.promptSlug` when logging the matching response.
 */
export function logPrompt(
	modelType: string,
	prompt: string,
	metadata?: PromptLogMetadata,
): string {
	if (!ensureFileLog()) return "";
	const counter = ++_promptLogCounter;
	const agentName = metadata?.agentName ?? "unknown";
	const slug = promptSlug(counter, agentName, modelType);
	writeToPromptLog(slug, "PROMPT", modelType, prompt, {
		...metadata,
		promptSlug: slug,
	});
	return slug;
}

/**
 * Log a response to prompts.log. Returns the correlated prompt slug, or an
 * empty string when no prompt slug is available.
 */
export function logResponse(
	modelType: string,
	response: string,
	metadata?: ResponseLogMetadata,
): string {
	if (!ensureFileLog()) return "";
	const slug = metadata?.promptSlug;
	if (!slug) {
		logger.warn(
			{ src: "logger" },
			"logResponse missing promptSlug - responses can't be correlated",
		);
		return "";
	}
	writeToPromptLog(slug, "RESPONSE", modelType, response, metadata);
	return slug;
}

// ============================================================================
// Chat instrumentation (chat.log)
// ============================================================================

export interface ChatInLogParams {
	agentName: string;
	agentId: string;
	roomId: string;
	messageId: string;
	text: string;
	source?: string;
}

export interface ChatOutLogParams {
	agentName: string;
	agentId: string;
	roomId: string;
	action: string;
	text?: string;
	emoji?: string;
	providers?: string[];
	reasoning?: string;
	actions?: string[];
}

const CHAT_PREVIEW_IN_MAX = 200;
const CHAT_PREVIEW_OUT_MAX = 120;

function escapeChatPreview(text: string): string {
	const safe = text.length > 10_000 ? text.slice(0, 10_000) : text;
	const oneLine = safe.replace(/\s+/g, " ").trim();
	return oneLine.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function writeChatLine(line: string): void {
	if (!ensureFileLog() || _chatLogFd === null) return;
	try {
		const timestamp = new Date().toISOString();
		fs.writeSync(_chatLogFd, `${timestamp} ${line}\n`);
	} catch {
		// Silent fail
	}
}

/** Log an incoming message to chat.log. */
export function logChatIn(params: ChatInLogParams): string {
	const preview = escapeChatPreview(
		params.text.length > CHAT_PREVIEW_IN_MAX
			? `${params.text.slice(0, CHAT_PREVIEW_IN_MAX)}...`
			: params.text,
	);
	const roomShort = params.roomId.slice(0, 8);
	const msgShort = params.messageId.slice(0, 8);
	const source = params.source ?? "unknown";
	const line = `[CHAT:IN]  #agent:${params.agentName} room=${roomShort} msg=${msgShort} source=${source} "${preview}"`;
	writeChatLine(line);
	return line;
}

/** Log an outgoing response to chat.log. */
export function logChatOut(params: ChatOutLogParams): string {
	const roomShort = params.roomId.slice(0, 8);
	let part = `[CHAT:OUT] #agent:${params.agentName} room=${roomShort} action=${params.action}`;
	if (params.actions && params.actions.length > 0) {
		part += ` actions=${params.actions.join(",")}`;
	}
	if (params.emoji) {
		part += ` emoji=${params.emoji}`;
	}
	if (params.text !== undefined && params.text !== "") {
		const preview = escapeChatPreview(
			params.text.length > CHAT_PREVIEW_OUT_MAX
				? `${params.text.slice(0, CHAT_PREVIEW_OUT_MAX)}...`
				: params.text,
		);
		part += ` len=${params.text.length} "${preview}"`;
	} else if (params.emoji) {
		part += " len=0";
	}
	if (params.providers && params.providers.length > 0) {
		part += ` providers=${params.providers.join(",")}`;
	}
	if (params.reasoning !== undefined && params.reasoning !== "") {
		const safe = escapeChatPreview(
			params.reasoning.length > 80
				? `${params.reasoning.slice(0, 80)}...`
				: params.reasoning,
		);
		part += ` reasoning="${safe}"`;
	}
	writeChatLine(part);
	return part;
}

// ============================================================================
// In-Memory Log Storage
// ============================================================================

/**
 * Creates an in-memory destination for storing recent logs
 */
function createInMemoryDestination(initialMaxLogs = 100): InMemoryDestination {
	const logs: LogEntry[] = [];
	let maxLogs = initialMaxLogs;

	return {
		write(entry: LogEntry): void {
			logs.push(entry);
			while (logs.length > maxLogs) {
				logs.shift();
			}
			if (logListeners.size === 0) return;
			// Snapshot so registration changes during a callback apply only to the
			// next entry and cannot revisit the current listener indefinitely.
			for (const listener of [...logListeners]) {
				// A listener earlier in the snapshot may unsubscribe a later one.
				// Honor that removal immediately without letting new registrations
				// join the current delivery.
				if (!logListeners.has(listener)) continue;
				try {
					listener(entry);
				} catch {
					// error-policy:J7 the logger is the diagnostics boundary, so report
					// directly without recursively invoking it or exposing the entry.
					if (!warnedLogListeners.has(listener)) {
						warnedLogListeners.add(listener);
						try {
							console.error(
								"[logger] log listener failed; continuing fan-out and suppressing further errors from this listener",
							);
						} catch {
							// error-policy:J7 a failed console sink cannot be re-reported.
						}
					}
				}
			}
		},
		clear(): void {
			logs.length = 0;
		},
		setMaxLogs(nextMaxLogs: number): void {
			// A bad binding must not disable retention or wipe the shared buffer, and
			// there is no public rounding contract, so honor only a finite safe
			// integer cap of at least 1. `Number.isSafeInteger` rejects fractional
			// (e.g. 0.5, which would otherwise floor to 0 and empty the ring), NaN,
			// ±Infinity, and unsafe-integer inputs in one check; the prior cap and
			// history then stand. Only trim when the cap shrinks below the current
			// fill so existing history is preserved.
			if (!Number.isSafeInteger(nextMaxLogs) || nextMaxLogs < 1) return;
			maxLogs = nextMaxLogs;
			while (logs.length > maxLogs) {
				logs.shift();
			}
		},
		recentLogs(): string {
			return logs
				.map((entry) => {
					const timestamp = showTimestamps
						? new Date(entry.time).toISOString()
						: "";
					// Convert numeric level back to string using the reverse mapping
					const levelStr = LEVEL_TO_NAME[entry.level ?? 30] || "info";
					return `${timestamp} ${levelStr} ${entry.msg}`.trim();
				})
				.join("\n");
		},
	};
}

// Global in-memory destination
const globalInMemoryDestination = createInMemoryDestination();

// ============================================================================
// Adze Configuration
// ============================================================================

// Configure Adze globally
// Map elizaOS log levels to Adze log levels
const getAdzeActiveLevel = () => {
	const level = effectiveLogLevel.toLowerCase();
	if (level === "trace") return "verbose";
	if (level === "debug") return "debug";
	if (level === "log") return "log";
	if (level === "info") return "info";
	if (level === "warn") return "warn";
	if (level === "error") return "error";
	if (level === "fatal") return "alert";
	return "info"; // Default to info
};

const adzeActiveLevel = getAdzeActiveLevel();

// Reusable custom level configuration using Adze's types
const customLevelConfig: Record<string, LevelConfiguration> = {
	alert: {
		levelName: "alert",
		level: 0,
		style: "font-size: 12px; color: #ff0000;",
		terminalStyle: ["bgRed", "white", "bold"] satisfies ConsoleStyle[],
		method: "error" satisfies Method,
		emoji: "",
	},
	error: {
		levelName: "error",
		level: 1,
		style: "font-size: 12px; color: #ff0000;",
		terminalStyle: ["bgRed", "whiteBright", "bold"] satisfies ConsoleStyle[],
		method: "error" satisfies Method,
		emoji: "",
	},
	warn: {
		levelName: "warn",
		level: 2,
		style: "font-size: 12px; color: #ffaa00;",
		terminalStyle: ["bgYellow", "black", "bold"] satisfies ConsoleStyle[],
		method: "warn" satisfies Method,
		emoji: "",
	},
	info: {
		levelName: "info",
		level: 3,
		style: "font-size: 12px; color: #0099ff;",
		terminalStyle: ["cyan"] satisfies ConsoleStyle[],
		method: "info" satisfies Method,
		emoji: "",
	},
	fail: {
		levelName: "fail",
		level: 4,
		style: "font-size: 12px; color: #ff6600;",
		terminalStyle: ["red", "underline"] satisfies ConsoleStyle[],
		method: "error" satisfies Method,
		emoji: "",
	},
	success: {
		levelName: "success",
		level: 5,
		style: "font-size: 12px; color: #00cc00;",
		terminalStyle: ["green"] satisfies ConsoleStyle[],
		method: "log" satisfies Method,
		emoji: "",
	},
	log: {
		levelName: "log",
		level: 6,
		style: "font-size: 12px; color: #888888;",
		terminalStyle: ["white"] satisfies ConsoleStyle[],
		method: "log" satisfies Method,
		emoji: "",
	},
	debug: {
		levelName: "debug",
		level: 7,
		style: "font-size: 12px; color: #9b59b6;",
		terminalStyle: ["gray", "dim"] satisfies ConsoleStyle[],
		method: "debug" satisfies Method,
		emoji: "",
	},
	verbose: {
		levelName: "verbose",
		level: 8,
		style: "font-size: 12px; color: #666666;",
		terminalStyle: ["gray", "dim", "italic"] satisfies ConsoleStyle[],
		method: "debug" satisfies Method,
		emoji: "",
	},
};

setup({
	activeLevel: adzeActiveLevel,
	format: raw ? "json" : "pretty",
	timestampFormatter: showTimestamps ? undefined : () => "",
	withEmoji: false,
	levels: customLevelConfig,
});

// Adze owns formatted output; createLogger().invoke owns the single in-memory
// dispatch so listeners receive one entry with Pino-compatible levels.

// ============================================================================
// Logger Factory
// ============================================================================

/**
 * Creates a sealed Adze logger instance with namespaces and metadata
 */
function sealAdze(base: Record<string, unknown>): ReturnType<typeof adze.seal> {
	let chain: ReturnType<typeof adze.ns> | typeof adze = adze as
		| ReturnType<typeof adze.ns>
		| typeof adze;

	// Add namespaces if provided
	const namespaces: string[] = [];
	if (typeof base.namespace === "string") namespaces.push(base.namespace);
	if (Array.isArray(base.namespaces))
		namespaces.push(...(base.namespaces as string[]));
	if (namespaces.length > 0) {
		chain = chain.ns(...namespaces);
	}

	// Add metadata (excluding namespace properties)
	const metaBase: Record<string, unknown> = { ...base };
	delete metaBase.namespace;
	delete metaBase.namespaces;

	// Add server context metadata (always, for observability)
	// Only add defaults if user hasn't provided them
	if (!metaBase.name) {
		metaBase.name = "elizaos";
	}

	// Add pid for process identification
	if (!metaBase.pid && process.pid) {
		metaBase.pid = process.pid;
	}

	// Add environment (production, development, test)
	if (!metaBase.environment) {
		metaBase.environment = process.env.NODE_ENV || "development";
	}

	// Add serverId for instance identification
	if (!metaBase.serverId) {
		metaBase.serverId = serverId;
	}

	// Add hostname (for JSON format or when explicitly needed)
	if (raw && !metaBase.hostname) {
		metaBase.hostname = hostname();
	}

	// This ensures the sealed logger inherits the correct log level and styling
	const globalConfig: UserConfiguration = {
		activeLevel: getAdzeActiveLevel(),
		format: raw ? "json" : "pretty",
		timestampFormatter: showTimestamps ? undefined : () => "",
		withEmoji: false,
		levels: customLevelConfig,
	};

	// Creation/child bindings bypass the per-call redaction in adaptArgs — Adze
	// emits the merged meta verbatim on every line — so scrub the bindings here:
	// logger.child({ apiKey }) must not print the key on each subsequent line.
	let safeMeta: Record<string, unknown>;
	try {
		safeMeta = redactLogValue(metaBase, new WeakSet<object>(), 0) as Record<
			string,
			unknown
		>;
	} catch {
		// error-policy:J7 logging must never break the runtime; an unwalkable
		// bindings payload degrades to a marker, never emits unredacted (W5-028).
		safeMeta = { redactionError: REDACTION_FAILED_VALUE };
	}

	return chain.meta(safeMeta).seal(globalConfig);
}

/**
 * Extract configuration from bindings
 */
function extractBindingsConfig(bindings: LoggerBindings | boolean): {
	level: string;
	base: Record<string, unknown>;
	maxMemoryLogs?: number;
} {
	let level = effectiveLogLevel;
	let base: Record<string, unknown> = {};
	let maxMemoryLogs: number | undefined;

	if (typeof bindings === "object" && bindings !== null) {
		if ("level" in bindings) {
			level = bindings.level as string;
		}
		if (
			"maxMemoryLogs" in bindings &&
			typeof bindings.maxMemoryLogs === "number"
		) {
			maxMemoryLogs = bindings.maxMemoryLogs;
		}

		// Extract base bindings (excluding special properties)
		const { level: _, maxMemoryLogs: __, ...rest } = bindings;
		base = rest;
	}

	// Namespace bindings bypass the per-call redaction like meta does: Adze
	// prints the ns tag and invoke() prefixes the ring-buffer message with the
	// raw value. Scrub credential shapes once here, where both consumers read.
	if (typeof base.namespace === "string") {
		base.namespace = redactSensitiveLogText(base.namespace);
	}
	if (Array.isArray(base.namespaces)) {
		base.namespaces = base.namespaces.map((ns) =>
			typeof ns === "string" ? redactSensitiveLogText(ns) : ns,
		);
	}

	return { level, base, maxMemoryLogs };
}

/**
 * Creates a logger instance using Adze
 * @param bindings - Logger configuration or boolean flag
 * @returns Logger instance with elizaOS API
 */
function createLogger(bindings: LoggerBindings | boolean = false): Logger {
	const { level, base, maxMemoryLogs } = extractBindingsConfig(bindings);

	// Apply the requested retention cap in place. Resizing preserves the shared
	// buffer's existing history instead of destroying every other logger's
	// recent-logs/streaming window; fractional, non-finite, unsafe-integer, and
	// non-positive values are ignored by setMaxLogs so the prior cap stands.
	if (typeof maxMemoryLogs === "number") {
		globalInMemoryDestination.setMaxLogs(maxMemoryLogs);
	}

	const sealed = sealAdze(base);
	const levelStr =
		typeof level === "number" ? "info" : level || effectiveLogLevel;
	const currentLevel = levelStr.toLowerCase();
	let warnedSinkFailure = false;

	/**
	 * Invoke Adze method with error capture
	 */
	const invoke = (method: string, ...args: unknown[]): void => {
		if (!shouldLog(method, currentLevel)) {
			return;
		}

		// Capture to in-memory destination for API access (even for namespaced loggers)
		let msg = "";
		if (args.length > 0) {
			msg = args
				.map((arg) => {
					if (typeof arg === "string") return arg;
					if (arg instanceof Error) return arg.message;
					return safeStringify(arg);
				})
				.join(" ");
		}

		if (base.namespace) {
			msg = `#${base.namespace}  ${msg}`;
		}

		const entry: LogEntry = {
			time: Date.now(),
			level:
				LOG_LEVEL_PRIORITY[method.toLowerCase()] || LOG_LEVEL_PRIORITY.info,
			msg,
		};

		globalInMemoryDestination.write(entry);
		writeLogEntryToFile(entry);

		let adzeMethod = method;
		let adzeArgs = args;

		if (method === "fatal") {
			// Adze uses 'alert' for fatal-level logging
			adzeMethod = "alert";
		} else if (method === "progress") {
			adzeMethod = "info";
			adzeArgs = ["[PROGRESS]", ...args];
		} else if (method === "success") {
			adzeMethod = "info";
			adzeArgs = ["[SUCCESS]", ...args];
		} else if (method === "trace") {
			adzeMethod = "verbose";
		}

		try {
			const loggerWithMethods = sealed as Log & AdzeLogMethods;
			const logMethod = loggerWithMethods[adzeMethod as keyof AdzeLogMethods];
			if (typeof logMethod === "function") {
				logMethod.call(loggerWithMethods, ...adzeArgs);
			}
		} catch {
			// error-policy:J7 report without re-entering Adze or exposing the failed entry.
			if (!warnedSinkFailure) {
				warnedSinkFailure = true;
				try {
					console.error(
						"[logger] formatted output sink failed; buffered logs remain available",
					);
				} catch {
					// error-policy:J7 a failed diagnostic console sink cannot be reported through itself.
				}
			}
		}
	};

	/**
	 * Safely redact sensitive data from an object.
	 * Deep-clones first so redaction never mutates the caller's live objects.
	 * Fails closed: a redactor failure must never emit the caller's original
	 * object — identified secrets would reach the sinks in cleartext (W5-028).
	 */
	const safeRedact = (
		obj: Record<string, unknown>,
	): Record<string, unknown> => {
		try {
			return redactLogValue(obj, new WeakSet<object>(), 0) as Record<
				string,
				unknown
			>;
		} catch {
			// error-policy:J7 logging must never break the runtime; the failure
			// degrades to a marker object, not the unredacted original.
			return { redactionError: REDACTION_FAILED_VALUE };
		}
	};

	/**
	 * Adapt elizaOS logger API arguments to Adze format
	 * Also applies redaction to sensitive data in objects
	 *
	 * In pretty mode: formats as compact single line [src] agent — message (extras)
	 * In JSON mode: keeps structured object for machine parsing
	 */
	const adaptArgs = (
		obj: Record<string, unknown> | string | Error,
		msg?: string,
		...args: unknown[]
	): unknown[] => {
		// String first argument - no context object. `msg` is typed string but
		// runtime callers do pass objects in that slot; fold it into the trailing
		// args so anything object-shaped still goes through the redactor.
		const cleanMsg =
			typeof msg === "string" ? redactSensitiveLogText(msg) : msg;
		if (typeof obj === "string") {
			const rest = cleanMsg !== undefined ? [cleanMsg, ...args] : args;
			return [redactSensitiveLogText(obj), ...redactTrailingArgs(rest)];
		}
		// A bare function in the context slot collapses like a function-valued
		// property: drop it and keep the message rather than handing the pretty
		// formatter the redactor's null stand-in.
		if (typeof obj === "function") {
			const rest = cleanMsg !== undefined ? [cleanMsg, ...args] : args;
			return redactTrailingArgs(rest);
		}
		// Error object - the wrapper must be redacted too: error instances can
		// carry credentials on enumerable properties (request config, headers),
		// and the headline message itself can interpolate the offending secret.
		if (obj instanceof Error) {
			const errorWrapper = safeRedact({ error: obj });
			const rest = cleanMsg !== undefined ? [cleanMsg, ...args] : args;
			return [
				redactSensitiveLogText(obj.message),
				errorWrapper,
				...redactTrailingArgs(rest),
			];
		}

		// Object (context) - redact sensitive data
		const redactedObj = safeRedact(obj);

		if (cleanMsg !== undefined) {
			// Pretty mode: format as compact single line
			if (!raw) {
				const formatted = formatPrettyLog(redactedObj, cleanMsg, raw);
				return [formatted, ...redactTrailingArgs(args)];
			}
			// JSON mode: keep structured object for machine parsing
			return [cleanMsg, redactedObj, ...redactTrailingArgs(args)];
		}

		// No message provided - just context object
		if (!raw) {
			// Pretty mode: format the object as a simple string
			const formatted = formatPrettyLog(redactedObj, "", raw);
			return formatted
				? [formatted, ...redactTrailingArgs(args)]
				: [...redactTrailingArgs(args)];
		}
		return [redactedObj, ...redactTrailingArgs(args)];
	};

	// Create log methods
	const trace: LogFn = (obj, msg, ...args) =>
		invoke("verbose", ...adaptArgs(obj, msg, ...args));
	const debug: LogFn = (obj, msg, ...args) =>
		invoke("debug", ...adaptArgs(obj, msg, ...args));
	const info: LogFn = (obj, msg, ...args) =>
		invoke("info", ...adaptArgs(obj, msg, ...args));
	const warn: LogFn = (obj, msg, ...args) =>
		invoke("warn", ...adaptArgs(obj, msg, ...args));
	const error: LogFn = (obj, msg, ...args) =>
		invoke("error", ...adaptArgs(obj, msg, ...args));
	const fatal: LogFn = (obj, msg, ...args) =>
		invoke("fatal", ...adaptArgs(obj, msg, ...args));
	const success: LogFn = (obj, msg, ...args) =>
		invoke("success", ...adaptArgs(obj, msg, ...args));
	const progress: LogFn = (obj, msg, ...args) =>
		invoke("progress", ...adaptArgs(obj, msg, ...args));
	const logFn: LogFn = (obj, msg, ...args) =>
		invoke("log", ...adaptArgs(obj, msg, ...args));

	/**
	 * Clear console and memory buffer
	 */
	const clear = (): void => {
		const consoleClear = console.clear;
		if (typeof consoleClear === "function") {
			consoleClear();
		}
		globalInMemoryDestination.clear();
	};

	/**
	 * Create child logger with additional bindings
	 */
	const child = (childBindings: Record<string, unknown>): Logger => {
		return createLogger({ level: currentLevel, ...base, ...childBindings });
	};

	return {
		level: currentLevel,
		trace,
		debug,
		info,
		warn,
		error,
		fatal,
		success,
		progress,
		log: logFn,
		clear,
		child,
	};
}

// ============================================================================
// Exports
// ============================================================================

// Create default logger instance
const logger = createLogger();

// Backward compatibility alias
export const elizaLogger = logger;

// Export recent logs function
export const recentLogs = (): string => globalInMemoryDestination.recentLogs();

// Export everything
export { createLogger, logger };
export default logger;
