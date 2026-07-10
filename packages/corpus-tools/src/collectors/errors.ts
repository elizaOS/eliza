/**
 * Typed failures for corpus collectors. Every collector fails closed on a
 * classifiable condition — a missing or wrong SQLCipher key, an unreadable
 * source database, a malformed export archive — rather than returning a
 * partial or fabricated corpus, so a broken pull is observable at the boundary
 * (the CLI translates the code to an exit status) instead of silently shipping
 * a truncated dataset. The `code` union is the contract the CLI and tests
 * branch on; widen it additively as new collectors land.
 */
import { ElizaError } from "@elizaos/core";

export type CollectorErrorCode =
  | "key_source_unavailable"
  | "key_decrypt_failed"
  | "sqlcipher_unavailable"
  | "db_open_failed"
  | "db_query_failed"
  | "source_missing"
  | "malformed_export"
  | "teardown_failed";

/**
 * Collector-scoped {@link ElizaError}. Carries the platform and a
 * machine-classifiable code so the CLI can map a decrypt/key/IO failure to a
 * distinct exit path and tests can assert the exact failure mode without
 * string-matching messages.
 */
export class CollectorError extends ElizaError {
  readonly collectorCode: CollectorErrorCode;

  constructor(
    message: string,
    options: {
      collectorCode: CollectorErrorCode;
      platform: string;
      cause?: unknown;
      context?: Record<string, unknown>;
    },
  ) {
    super(message, {
      code: `collector:${options.platform}:${options.collectorCode}`,
      cause: options.cause,
      context: { platform: options.platform, ...options.context },
    });
    this.collectorCode = options.collectorCode;
  }
}

export function isCollectorError(
  value: unknown,
  code?: CollectorErrorCode,
): value is CollectorError {
  if (!(value instanceof CollectorError)) return false;
  return code === undefined || value.collectorCode === code;
}
