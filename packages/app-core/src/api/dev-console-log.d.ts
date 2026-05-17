/**
 * Limits which file the API may tail (env is untrusted even on loopback).
 * Requires both the correct basename AND a `.eliza` parent directory to
 * prevent reading arbitrary files named `desktop-dev-console.log`.
 */
export declare function isAllowedDevConsoleLogPath(absPath: string): boolean;
export type ReadDevConsoleLogResult =
  | {
      ok: true;
      body: string;
    }
  | {
      ok: false;
      error: string;
    };
/**
 * Read the last portion of a log file (by bytes first, then keep last N lines).
 */
export declare function readDevConsoleLogTail(
  absPath: string,
  options?: {
    maxLines?: number;
    maxBytes?: number;
  },
): ReadDevConsoleLogResult;
//# sourceMappingURL=dev-console-log.d.ts.map
