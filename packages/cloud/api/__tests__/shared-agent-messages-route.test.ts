// Exercises cloud API tests shared agent messages route.test behavior with deterministic Worker route fixtures.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { InsufficientCreditsError } from "@/lib/api/errors";
import * as realResolveSharedAgent from "@/lib/services/shared-runtime/resolve-shared-agent";
import * as realSharedRestAdapter from "@/lib/services/shared-runtime/shared-rest-adapter";
import * as realLogger from "@/lib/utils/logger";

const resolveSharedAgent = mock();
const sharedRestMessageSend = mock();
const sharedRestMessagesGet = mock();
const loggerWarn = mock(() => undefined);

mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  ...realResolveSharedAgent,
  resolveSharedAgent,
}));

mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  ...realSharedRestAdapter,
  sharedRestMessageSend,
  sharedRestMessagesGet,
}));

mock.module("@/lib/utils/logger", () => ({
  ...realLogger,
  logger: {
    ...realLogger.logger,
    warn: loggerWarn,
  },
}));

const messagesRoute = (
  await import(
    "../v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages/route"
  )
).default;

afterAll(() => {
  mock.module(
    "@/lib/services/shared-runtime/resolve-shared-agent",
    () => realResolveSharedAgent,
  );
  mock.module(
    "@/lib/services/shared-runtime/shared-rest-adapter",
    () => realSharedRestAdapter,
  );
  mock.module("@/lib/utils/logger", () => realLogger);
});

const AGENT = "de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const ORG = "org-1";
const APP_ORIGIN = "https://localhost";

function postMessage(body: unknown, origin?: string) {
  const headers: Record<string, string> = {
    Authorization: "Bearer user-api-key",
    "Content-Type": "application/json",
  };
  if (origin) headers.Origin = origin;
  return messagesRoute.request("/", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("shared agent messages route", () => {
  beforeEach(() => {
    resolveSharedAgent.mockReset();
    sharedRestMessageSend.mockReset();
    sharedRestMessagesGet.mockReset();
    loggerWarn.mockClear();
    resolveSharedAgent.mockResolvedValue({
      agent: {},
      agentId: AGENT,
      orgId: ORG,
      agentName: "Eliza",
    });
  });

  test("returns assistant text from the shared REST adapter", async () => {
    sharedRestMessageSend.mockResolvedValue({
      text: "hello",
      agentName: "Eliza",
    });

    const res = await postMessage({ text: "say hi" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      text: "hello",
      agentName: "Eliza",
    });
    expect(sharedRestMessageSend).toHaveBeenCalledWith(
      AGENT,
      ORG,
      AGENT,
      "say hi",
      "Eliza",
    );
  });

  test("returns a sanitized retryable 503 when shared runtime inference fails", async () => {
    sharedRestMessageSend.mockRejectedValue(
      new Error("provider secret detail: upstream 500"),
    );

    const res = await postMessage({ text: "hello" }, APP_ORIGIN);

    expect(res.status).toBe(503);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "The agent is temporarily unavailable. Please try again.",
      code: "inference_unavailable",
      retryable: true,
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      "[shared-runtime REST] message.send failed",
      {
        agentId: AGENT,
        error: "provider secret detail: upstream 500",
      },
    );
  });

  test("empty text returns 400 without calling the adapter", async () => {
    const res = await postMessage({ text: "  " });
    expect(res.status).toBe(400);
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  // The bug this pins: insufficient credits is a PERMANENT add-credits
  // condition (welcome-bonus-withheld signups, drained orgs), and the blanket
  // 503 above disguised it as a transient outage — "try again" forever. The
  // route must return the canonical 402 so the app can route to top-up.
  test("insufficient credits returns a non-retryable 402, not the retryable 503", async () => {
    sharedRestMessageSend.mockRejectedValue(
      new InsufficientCreditsError(
        "Insufficient credits. Required: $0.0500, Available: $0.0000",
      ),
    );

    const res = await postMessage({ text: "hello" }, APP_ORIGIN);

    expect(res.status).toBe(402);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Insufficient credits. Required: $0.0500, Available: $0.0000",
      code: "insufficient_credits",
      retryable: false,
    });
  });
});
