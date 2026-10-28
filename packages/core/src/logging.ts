/** Browser-safe logger contracts and credential redaction. No Node logger initialization. */
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

export { redactTrailingArgs } from "./security/log-redaction.js";
