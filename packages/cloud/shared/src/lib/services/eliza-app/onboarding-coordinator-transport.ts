/**
 * Preserves typed onboarding failures across the Durable Object HTTP boundary
 * while treating every response body as untrusted transport input.
 */

import { ElizaError, isElizaError } from "@elizaos/core/edge";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Serializes an onboarding failure without changing the boundary's status. */
export function onboardingCoordinatorErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (!isElizaError(error)) {
    return Response.json({ error: message }, { status: 500 });
  }
  return Response.json(
    { error: message, code: error.code, context: error.context },
    { status: 500 },
  );
}

/** Reads a coordinator result and reconstructs only a fully identified error. */
export async function readOnboardingCoordinatorResult<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // error-policy:J3 An unreadable boundary body is explicitly invalid and
    // must not acquire a trusted application error code.
    throw new Error(`onboarding session coordinator failed (${response.status})`);
  }

  if (isRecord(payload)) {
    const message = payload.error;
    const code = payload.code;
    if (typeof message === "string" && typeof code === "string" && code.trim().length > 0) {
      const context = isRecord(payload.context) ? payload.context : undefined;
      throw new ElizaError(message, { code, context });
    }
  }

  throw new Error(`onboarding session coordinator failed (${response.status})`);
}
