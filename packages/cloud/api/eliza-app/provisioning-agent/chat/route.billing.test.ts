/** Verifies provisioning chat standing denial before the paid service boundary. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  getGenerativeOperationContext,
  paidBoundaryState,
  requireGenerativeKnownIdentity,
  requireGenerativeRouteCaller,
  resetPaidBoundaryRouteMocks,
} from "../../../__tests__/paid-boundary-route-test-mocks";

const validateAuthHeader = mock(async () => ({
  userId: "user-1",
  organizationId: "org-1",
}));
const provisioningAgentChat = mock(async (_params: unknown) => ({
  reply: "ready",
  containerStatus: "none" as const,
  bridgeUrl: null,
  agentId: null,
  history: [],
}));

mock.module("@/lib/services/eliza-app", () => ({
  elizaAppSessionService: { validateAuthHeader },
}));
mock.module("@/api-app/lib/generative-route-auth", () => ({
  getGenerativeOperationContext,
  requireGenerativeKnownIdentity,
  requireGenerativeRouteCaller,
}));
mock.module("@/lib/services/provisioning-agent-chat", () => ({
  provisioningAgentChat,
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined, info: () => undefined },
}));

const { default: app } = await import("./route");

beforeEach(() => {
  validateAuthHeader.mockClear();
  requireGenerativeKnownIdentity.mockClear();
  getGenerativeOperationContext.mockClear();
  provisioningAgentChat.mockClear();
  resetPaidBoundaryRouteMocks();
});

describe("POST /api/eliza-app/provisioning-agent/chat billing boundary", () => {
  test("revalidates standing once and passes one operation context to the service", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: {
        authorization: "Bearer signed-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(response.status).toBe(200);
    expect(validateAuthHeader).toHaveBeenCalledTimes(1);
    expect(requireGenerativeKnownIdentity).toHaveBeenCalledTimes(1);
    expect(getGenerativeOperationContext).toHaveBeenCalledTimes(1);
    expect(provisioningAgentChat).toHaveBeenCalledTimes(1);
    expect(provisioningAgentChat.mock.calls[0]?.[0]).toMatchObject({
      userId: "user-1",
      organizationId: "org-1",
      operationContext: { requestId: "request-1" },
    });
  });

  test("standing denial never crosses the paid service boundary", async () => {
    paidBoundaryState.knownIdentityError = new Error("account inactive");
    const response = await app.request("/", {
      method: "POST",
      headers: {
        authorization: "Bearer signed-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(response.status).toBe(500);
    expect(validateAuthHeader).toHaveBeenCalledTimes(1);
    expect(requireGenerativeKnownIdentity).toHaveBeenCalledTimes(1);
    expect(getGenerativeOperationContext).not.toHaveBeenCalled();
    expect(provisioningAgentChat).not.toHaveBeenCalled();
  });

  test("invalid input performs no standing read and no paid service call", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: {
        authorization: "Bearer signed-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "" }),
    });

    expect(response.status).toBe(400);
    expect(requireGenerativeKnownIdentity).not.toHaveBeenCalled();
    expect(provisioningAgentChat).not.toHaveBeenCalled();
  });
});
