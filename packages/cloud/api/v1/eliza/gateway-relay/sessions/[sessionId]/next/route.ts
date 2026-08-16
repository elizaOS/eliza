/**
 * GET /api/v1/eliza/gateway-relay/sessions/:sessionId/next
 *
 * Long-poll for the next bridge request envelope on this relay session.
 * Caps the wait at 25s so platform-level edge timeouts can never strand a
 * client waiting on a closed connection.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { agentGatewayRelayService } from "@/lib/services/agent-gateway-relay";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const DEFAULT_TIMEOUT_MS = 25_000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 25_000;

export type TimeoutMsParseResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Canonical long-poll wait at the HTTP boundary.
 * Missing or empty defaults to the 25s platform cap. Any other token must be
 * a complete ASCII decimal integer in [1, 25000] — no sign, zero, fraction,
 * hex, scientific notation, leading zeros, whitespace, junk, or values above
 * the cap. Prefix-legal garbage must not coerce (parseInt("1e4", 10) is 1
 * and would return empty immediately instead of waiting 10s).
 */
export function parseTimeoutMs(raw: string | undefined): TimeoutMsParseResult {
  if (raw === undefined || raw === "") {
    return { ok: true, value: DEFAULT_TIMEOUT_MS };
  }

  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    return {
      ok: false,
      error: `Invalid timeoutMs ${JSON.stringify(
        raw,
      )}: expected a canonical decimal integer`,
    };
  }

  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_TIMEOUT_MS ||
    parsed > MAX_TIMEOUT_MS
  ) {
    return {
      ok: false,
      error: `Invalid timeoutMs ${JSON.stringify(
        raw,
      )}: expected an integer between 1 and 25000`,
    };
  }

  return { ok: true, value: parsed };
}

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const sessionId = c.req.param("sessionId") ?? "";
    const session = await agentGatewayRelayService.getSession(sessionId);

    if (!session) {
      return c.json({ success: false, error: "Session not found" }, 404);
    }

    if (
      session.organizationId !== user.organization_id ||
      session.userId !== user.id
    ) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }

    const timeout = parseTimeoutMs(c.req.query("timeoutMs"));
    if (!timeout.ok) {
      return c.json({ success: false, error: timeout.error }, 400);
    }

    const requestEnvelope = await agentGatewayRelayService.pollNextRequest(
      sessionId,
      timeout.value,
    );

    return c.json({
      success: true,
      data: { request: requestEnvelope },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
