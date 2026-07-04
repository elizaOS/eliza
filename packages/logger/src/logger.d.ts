/**
 * elizaOS's standard structured logger, built on Adze. Exposes the `Logger`
 * interface and the `createLogger` factory (plus the default `logger` /
 * `elizaLogger` singletons) as a Pino-shaped API extended with custom
 * `success`/`progress` levels. Redacts sensitive fields via fast-redact, keeps
 * an in-memory ring buffer with real-time listeners for WebSocket streaming,
 * and lazily opens optional file sinks (`output.log`, `prompts.log`,
 * `chat.log`) with prompt/response/chat instrumentation helpers. Adapts between
 * node and a console-based browser path.
 */
export declare const __loggerTestHooks: {
    clearEnvCacheForTests: () => void;
};
/**
 * Log function signature matching Pino's API for compatibility
 */
type LogFn = (obj: Record<string, unknown> | string | Error, msg?: string, ...args: unknown[]) => void;
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
    maxMemoryLogs?: number;
    __forceType?: "browser" | "node";
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
/**
 * Add a listener for real-time log entries (used for WebSocket streaming)
 * @param listener - Callback function to receive log entries
 * @returns Function to remove the listener
 */
export declare function addLogListener(listener: LogListener): () => void;
/**
 * Remove a log listener
 * @param listener - The listener to remove
 */
export declare function removeLogListener(listener: LogListener): void;
export declare const customLevels: Record<string, number>;
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
/**
 * Log a prompt to prompts.log. Returns the slug callers can pass as
 * `metadata.promptSlug` when logging the matching response.
 */
export declare function logPrompt(modelType: string, prompt: string, metadata?: PromptLogMetadata): string;
/**
 * Log a response to prompts.log. Returns the correlated prompt slug, or an
 * empty string when no prompt slug is available.
 */
export declare function logResponse(modelType: string, response: string, metadata?: ResponseLogMetadata): string;
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
/** Log an incoming message to chat.log. */
export declare function logChatIn(params: ChatInLogParams): string;
/** Log an outgoing response to chat.log. */
export declare function logChatOut(params: ChatOutLogParams): string;
/**
 * Creates a logger instance using Adze
 * @param bindings - Logger configuration or boolean flag
 * @returns Logger instance with elizaOS API
 */
declare function createLogger(bindings?: LoggerBindings | boolean): Logger;
declare const logger: Logger;
export declare const elizaLogger: Logger;
export declare const recentLogs: () => string;
export { createLogger, logger };
export default logger;
//# sourceMappingURL=logger.d.ts.map