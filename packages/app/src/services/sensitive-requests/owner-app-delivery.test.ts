import { ChannelType, type DispatchSensitiveRequest } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { ownerAppInlineSensitiveRequestAdapter } from "./owner-app-inline-adapter";
import { ownerAppOAuthSensitiveRequestAdapter } from "./owner-app-oauth-adapter";

const oauthUrl = "https://provider.example/authorize?state=private-state";
function request(
  kind: "secret" | "oauth",
  ownerPrivate: boolean,
): DispatchSensitiveRequest {
  return {
    id: "request",
    agentId: "agent",
    status: "pending",
    kind,
    sourceChannelType: ownerPrivate ? ChannelType.DM : ChannelType.GROUP,
    sourcePlatform: ownerPrivate ? "owner_app" : "discord",
    target:
      kind === "secret"
        ? { kind, key: "API_KEY" }
        : { kind, provider: "provider", authorizationUrl: oauthUrl },
    delivery: { mode: ownerPrivate ? "inline_owner_app" : "instruct_dm_only" },
    expiresAt: 12345,
  };
}

describe.each([
  ["secret", ownerAppInlineSensitiveRequestAdapter],
  ["oauth", ownerAppOAuthSensitiveRequestAdapter],
] as const)("owner-only %s delivery", (kind, adapter) => {
  it("rejects public channels before dispatch", async () => {
    const sendMessageToTarget = vi.fn();
    const result = await adapter.deliver({
      request: request(kind, false),
      runtime: { sendMessageToTarget },
    });
    expect(result.delivered).toBe(false);
    expect(sendMessageToTarget).not.toHaveBeenCalled();
  });
  it("does not report success without transport confirmation", async () => {
    const sendMessageToTarget = vi.fn().mockResolvedValue(undefined);
    const result = await adapter.deliver({
      request: request(kind, true),
      runtime: { sendMessageToTarget },
    });
    expect(result.delivered).toBe(false);
    expect(sendMessageToTarget).toHaveBeenCalledOnce();
    if (kind === "oauth") {
      const content = sendMessageToTarget.mock.calls[0][1];
      expect(content.text).not.toContain(oauthUrl);
      expect(content.secretRequest.form.authorizationUrl).toBe(oauthUrl);
    }
  });
});
