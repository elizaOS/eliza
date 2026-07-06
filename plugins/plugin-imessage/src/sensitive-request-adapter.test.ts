/**
 * Unit tests for the iMessage sensitive-request adapter. The service is stubbed
 * so the tests verify dispatch behavior without macOS Messages.app.
 */

import type { IAgentRuntime, SensitiveRequest } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async () => await vi.importActual("@elizaos/core"));

import { imessageDmSensitiveRequestAdapter } from "./sensitive-request-adapter";
import { IMessageService } from "./service";

function makeRequest(overrides: Partial<SensitiveRequest> = {}): SensitiveRequest {
  return {
    id: "req-1",
    kind: "secret",
    status: "pending",
    agentId: "agent-1",
    requesterEntityId: "+14155552671",
    target: { kind: "secret", key: "OPENAI_API_KEY" },
    policy: {
      actor: "owner_or_linked_identity",
      requirePrivateDelivery: true,
      requireAuthenticatedLink: true,
      allowInlineOwnerAppEntry: true,
      allowPublicLink: false,
      allowDmFallback: true,
      allowTunnelLink: true,
      allowCloudLink: true,
    },
    delivery: {
      kind: "secret",
      source: "dm",
      mode: "private_dm",
      policy: {
        actor: "owner_or_linked_identity",
        requirePrivateDelivery: true,
        requireAuthenticatedLink: true,
        allowInlineOwnerAppEntry: true,
        allowPublicLink: false,
        allowDmFallback: true,
        allowTunnelLink: true,
        allowCloudLink: true,
      },
      privateRouteRequired: true,
      publicLinkAllowed: false,
      authenticated: false,
      canCollectValueInCurrentChannel: true,
      reason: "current channel is private",
      instruction: "Open the app.",
    },
    callback: { url: "https://app.test/secret/req-1" },
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:00.000Z",
    ...overrides,
  } as SensitiveRequest;
}

function makeRuntime(service: unknown): IAgentRuntime {
  return {
    getService: vi.fn((name: string) => (name === IMessageService.serviceType ? service : null)),
  } as unknown as IAgentRuntime;
}

describe("imessageDmSensitiveRequestAdapter", () => {
  it("sends only secure-link prose and returns delivered=true", async () => {
    const sendMessage = vi.fn(async () => ({ success: true, messageId: "m-1" }));
    const runtime = makeRuntime({ sendMessage });
    const request = makeRequest();

    const result = await imessageDmSensitiveRequestAdapter.deliver({
      request,
      runtime,
    });

    expect(result).toEqual({
      delivered: true,
      target: "dm",
      channelId: "+14155552671",
      url: "https://app.test/secret/req-1",
      expiresAt: request.expiresAt,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "+14155552671",
      expect.stringContaining("https://app.test/secret/req-1")
    );
    expect(sendMessage.mock.calls[0]?.[1]).not.toContain("OPENAI_API_KEY=");
  });

  it("returns delivered=false when no target handle is available", async () => {
    const sendMessage = vi.fn();
    const runtime = makeRuntime({ sendMessage });
    const request = makeRequest({ requesterEntityId: null, originUserId: null });

    const result = await imessageDmSensitiveRequestAdapter.deliver({
      request,
      runtime,
    });

    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/no imessage handle/i);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("returns delivered=false when the service send fails", async () => {
    const runtime = makeRuntime({
      sendMessage: vi.fn(async () => ({ success: false, error: "not delivered" })),
    });

    const result = await imessageDmSensitiveRequestAdapter.deliver({
      request: makeRequest(),
      runtime,
    });

    expect(result).toMatchObject({
      delivered: false,
      target: "dm",
      channelId: "+14155552671",
      error: "not delivered",
    });
  });
});
