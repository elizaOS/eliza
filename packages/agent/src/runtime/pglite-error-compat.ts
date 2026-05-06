/**
 * Pglite error utilities.
 *
 * These are defined locally because the published @elizaos/plugin-sql npm
 * package (beta dist-tag) does not yet export them. Once the plugin-sql
 * submodule ships a release that includes pglite/errors.ts, we can remove
 * this file and import directly from "@elizaos/plugin-sql".
 */

export const PGLITE_ERROR_CODES = {
  ACTIVE_LOCK: "ELIZA_PGLITE_DATA_DIR_IN_USE",
  CORRUPT_DATA: "ELIZA_PGLITE_CORRUPT_DATA",
  MANUAL_RESET_REQUIRED: "ELIZA_PGLITE_MANUAL_RESET_REQUIRED",
} as const;

export type PgliteErrorCode =
  (typeof PGLITE_ERROR_CODES)[keyof typeof PGLITE_ERROR_CODES];

export class PgliteInitError extends Error {
  public readonly code: PgliteErrorCode;
  public readonly dataDir?: string;

  constructor(
    code: PgliteErrorCode,
    message: string,
    options?: { cause?: unknown; dataDir?: string },
  ) {
    super(message, { cause: options?.cause });
    this.name = "PgliteInitError";
    this.code = code;
    this.dataDir = options?.dataDir;
  }
}

export function createPgliteInitError(
  code: PgliteErrorCode,
  message: string,
  options?: { cause?: unknown; dataDir?: string },
): PgliteInitError {
  return new PgliteInitError(code, message, options);
}

export function getPgliteErrorCode(err: unknown): PgliteErrorCode | null {
  const seen = new Set<unknown>();
  let current: unknown = err;

  while (current && !seen.has(current)) {
    seen.add(current);
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      typeof (current as { code?: unknown }).code === "string"
    ) {
      const code = (current as { code: string }).code;
      if (
        code === PGLITE_ERROR_CODES.ACTIVE_LOCK ||
        code === PGLITE_ERROR_CODES.CORRUPT_DATA ||
        code === PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED
      ) {
        return code;
      }
    }

    if (current instanceof Error) {
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }

    if (typeof current === "object" && current !== null && "cause" in current) {
      current = (current as { cause?: unknown }).cause;
      continue;
    }

    break;
  }

  return null;
}
