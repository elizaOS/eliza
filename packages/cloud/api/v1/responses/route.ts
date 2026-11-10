/** Adapts OpenAI Responses requests to the canonical chat auth and admission pipeline. */

import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { createPreflightResponse } from "@elizaos/cloud-shared/lib/middleware/cors-apps";
import { copyHttpTelemetryHeaders } from "@elizaos/cloud-shared/lib/observability/http-telemetry";
import {
  nativeApplicationInferenceErrorResponse,
  prepareNativeApplicationInference,
} from "@elizaos/cloud-shared/lib/services/native-application-inference";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { type Context, Hono } from "hono";
import { handleChatCompletionsPOST } from "../chat/completions/route";

import {
  mapChatCompletionToResponse,
  type ParsedResponsesRequest,
  parseResponsesRequest,
  ResponsesInputError,
} from "./compatibility";

const app = new Hono<AppEnv>();

function jsonError(
  message: string,
  status = 400,
  code = "invalid_request_error",
) {
  return Response.json(
    {
      error: {
        message,
        type: "invalid_request_error",
        code,
      },
    },
    { status },
  );
}

function buildChatRequest(original: Request, body: ParsedResponsesRequest) {
  const headers = new Headers(original.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  return new Request(original.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, stream: false }),
    signal: original.signal,
  });
}

function providerUnavailable(c: Context<AppEnv>, headers?: Headers) {
  const response = c.json(
    {
      success: false,
      error: "Responses provider unavailable",
      code: "internal_error",
    },
    503,
  );
  if (headers) copyHttpTelemetryHeaders(headers, response.headers);
  return response;
}

app.options("/", (c) =>
  createPreflightResponse(c.req.header("origin") ?? null, ["POST", "OPTIONS"]),
);

app.post("/", async (c) => {
  try {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return jsonError("Request body must be valid JSON");
    }
    const body = parseResponsesRequest(raw);
    const chatRequest = buildChatRequest(c.req.raw, body);
    const native = await prepareNativeApplicationInference(c, chatRequest);
    const chatResponse = await handleChatCompletionsPOST(native.request, {
      appFundingActor: native.actor,
      executionCtx: c.executionCtx,
      traceId: c.get("traceId"),
    });

    if (!chatResponse.ok) {
      if (chatResponse.status >= 500)
        return providerUnavailable(c, chatResponse.headers);
      return chatResponse;
    }
    try {
      const response = c.json(
        mapChatCompletionToResponse(await chatResponse.json()),
      );
      copyHttpTelemetryHeaders(chatResponse.headers, response.headers);
      return response;
    } catch {
      logger.error("[Responses] Canonical response could not be represented", {
        traceId: c.get("traceId"),
        code: "invalid_canonical_response",
      });
      return providerUnavailable(c, chatResponse.headers);
    }
  } catch (error) {
    if (error instanceof ResponsesInputError)
      return jsonError(error.message, 400, error.code);
    // error-policy:J1 Translate explicit native product authority failures at the HTTP boundary.
    const nativeError = nativeApplicationInferenceErrorResponse(error);
    if (nativeError) return nativeError;
    const response = failureResponse(c, error);
    if (response.status >= 500) {
      return c.json(
        {
          success: false,
          error: "Responses provider unavailable",
          code: "internal_error",
        },
        503,
      );
    }
    return response;
  }
});

/** Deterministic compatibility transformations exposed for route contract tests. */
export const __responsesRouteTestHooks = {
  buildChatRequest,
  mapChatCompletionToResponse,
  toChatMessages: (body: unknown) => parseResponsesRequest(body).messages,
};

export default app;
