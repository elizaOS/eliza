/**
 * Brokered provider-call endpoint for first-party plugins.
 *
 * POST /api/v1/connections/:id/broker executes one provider API request using
 * the credential behind an opaque connection ID. Inbound Eliza auth/cookies
 * are never forwarded upstream: the broker builds the provider request from
 * the validated JSON body and injects the provider credential server-side.
 * Raw token material never appears in the response.
 */

import { Hono } from "hono";

import { ApiError } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  credentialBroker,
  internalErrorResponse,
  OAuthError,
} from "@/lib/services/oauth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface BrokerRequestBody {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

function parseBrokerBody(raw: unknown): BrokerRequestBody | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.method !== "string" || typeof candidate.url !== "string")
    return null;
  if (candidate.body !== undefined && typeof candidate.body !== "string")
    return null;
  if (candidate.headers !== undefined) {
    if (
      !candidate.headers ||
      typeof candidate.headers !== "object" ||
      Array.isArray(candidate.headers)
    ) {
      return null;
    }
    for (const value of Object.values(
      candidate.headers as Record<string, unknown>,
    )) {
      if (typeof value !== "string") return null;
    }
  }
  return {
    method: candidate.method,
    url: candidate.url,
    headers: candidate.headers as Record<string, string> | undefined,
    body: candidate.body as string | undefined,
  };
}

async function __hono_POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: connectionId } = await params;
  let organizationId: string | undefined;

  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    organizationId = user.organization_id;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      // error-policy:J3 untrusted-input sanitizing — malformed JSON becomes an
      // explicit 400, never a pass-through default.
      return Response.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    const body = parseBrokerBody(rawBody);
    if (!body) {
      return Response.json(
        {
          error:
            "Body must include string `method` and `url`; `headers`/`body` optional",
        },
        { status: 400 },
      );
    }

    const result = await credentialBroker.callProvider({
      organizationId,
      userId: user.id,
      connectionId,
      request: body,
    });

    return Response.json(result);
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json(error.toJSON(), { status: error.status });
    }
    if (error instanceof OAuthError) {
      return Response.json(error.toResponse(), { status: error.httpStatus });
    }
    logger.error("[API] POST /api/v1/connections/:id/broker error", {
      organizationId,
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      internalErrorResponse("Brokered provider request failed"),
      {
        status: 500,
      },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, {
    params: Promise.resolve({ id: c.req.param("id")! }),
  }),
);
export default __hono_app;
