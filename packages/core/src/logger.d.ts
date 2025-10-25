export declare const __loggerTestHooks: {
    __noop: () => void;
};
/**
 * Log function signature matching Pino's API for compatibility
 */
type LogFn = (obj: Record<string, unknown> | string | Error, msg?: string, ...args: unknown[]) => void;
/**
 * Logger interface - ElizaOS standard logger API
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
    __forceType?: 'browser' | 'node';
}
export declare const customLevels: Record<string, number>;
/**
 * Creates a logger instance using Adze
 * @param bindings - Logger configuration or boolean flag
 * @returns Logger instance with ElizaOS API
 */
declare function createLogger(bindings?: LoggerBindings | boolean): Logger;
declare const logger: Logger;
export declare const elizaLogger: Logger;
export declare const recentLogs: () => string;
export { logger, createLogger };
export default logger;
//# sourceMappingURL=logger.d.ts.map