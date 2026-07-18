/** Narrow transport retry for audit-only API reads against the live local stack. */
import type { APIRequestContext, APIResponse } from "@playwright/test";

const TRANSIENT_AUDIT_TRANSPORT_PATTERN =
  /ECONNRESET|EPIPE|socket (?:hang up|closed)|other side closed/i;

export function isTransientAuditTransportError(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4 && candidate; depth += 1) {
    if (typeof candidate === "string") {
      if (TRANSIENT_AUDIT_TRANSPORT_PATTERN.test(candidate)) return true;
      break;
    }
    if (candidate instanceof Error) {
      if (TRANSIENT_AUDIT_TRANSPORT_PATTERN.test(candidate.message))
        return true;
    }
    if (typeof candidate !== "object") break;
    const record = candidate as { code?: unknown; cause?: unknown };
    if (
      typeof record.code === "string" &&
      TRANSIENT_AUDIT_TRANSPORT_PATTERN.test(record.code)
    ) {
      return true;
    }
    candidate = record.cause;
  }
  return false;
}

export async function getAuditResponseWithTransportRetry(
  request: Pick<APIRequestContext, "get">,
  url: string,
  {
    attempts = 3,
    wait = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  }: {
    attempts?: number;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<APIResponse> {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("Audit request attempts must be a positive integer");
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request.get(url);
    } catch (error) {
      // error-policy:J1 The audit request is the transport boundary. Retry only
      // explicit local socket resets; HTTP failures remain ordinary responses,
      // and non-transient or exhausted failures surface unchanged.
      if (attempt === attempts || !isTransientAuditTransportError(error)) {
        throw error;
      }
      await wait(75 * attempt);
    }
  }
  throw new Error("Audit request retry loop exhausted unexpectedly");
}
