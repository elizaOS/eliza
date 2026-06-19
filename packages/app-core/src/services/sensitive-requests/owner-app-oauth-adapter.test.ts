import {
  ChannelType,
  type Content,
  type DispatchSensitiveRequest,
  defaultSensitiveRequestPolicy,
  resolveSensitiveRequestDelivery,
  type TargetInfo,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { ownerAppOAuthSensitiveRequestAdapter } from "./owner-app-oauth-adapter";

const REQUEST_ID = "req_oauth_test_123";
const ROOM_ID = "33333333-3333-3333-3333-333333333333";
const ENTITY_ID = "44444444-4444-4444-4444-444444444444";
const AUTHZ_URL =
  "https://github.com/login/oauth/authorize?client_id=abc&state=xyz";

interface CapturedSend {
  target: TargetInfo;
  content: Content & { secretRequest?: unknown };
}

function makeRuntime(): {
  runtime: {
    sendMessageToTarget: (
      target: TargetInfo,
      content: Content,
    ) => Promise<void>;
  };
  calls: CapturedSend[];
} {
  const calls: CapturedSend[] = [];
  const sendMessageToTarget = vi.fn(
    async (target: TargetInfo, content: Content) => {
      calls.push({
        target,
        content: content as CapturedSend["content"],
      });
    },
  );
  return { runtime: { sendMessageToTarget }, calls };
}

function makeOwnerAppPrivateOAuthRequest(
  overrides: Partial<DispatchSensitiveRequest> = {},
): DispatchSensitiveRequest {
  const delivery = resolveSensitiveRequestDelivery({
    kind: "oauth",
    environment: { ownerApp: { privateChat: true } },
  });
  return {
    id: REQUEST_ID,
    kind: "oauth",
    status: "pending",
    agentId: "agent-1",
    ownerEntityId: ENTITY_ID,
    sourceRoomId: ROOM_ID,
    sourceChannelType: ChannelType.DM,
    sourcePlatform: "owner_app",
    target: {
      kind: "oauth",
      provider: "github",
      label: "GitHub",
      scopes: ["repo", "read:user"],
      authorizationUrl: AUTHZ_URL,
    },
    policy: defaultSensitiveRequestPolicy("oauth"),
    delivery,
    expiresAt: "2026-07-11T00:00:00.000Z",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  } as unknown as DispatchSensitiveRequest;
}

function makePublicOAuthRequest(): DispatchSensitiveRequest {
  const delivery = resolveSensitiveRequestDelivery({
    kind: "oauth",
    channelType: ChannelType.GROUP,
    environment: { ownerApp: { privateChat: false } },
  });
  return {
    id: "req_oauth_pub",
    kind: "oauth",
    status: "pending",
    agentId: "agent-1",
    ownerEntityId: ENTITY_ID,
    sourceRoomId: ROOM_ID,
    sourceChannelType: ChannelType.GROUP,
    sourcePlatform: "discord",
    target: {
      kind: "oauth",
      provider: "github",
      authorizationUrl: AUTHZ_URL,
    },
    policy: defaultSensitiveRequestPolicy("oauth"),
    delivery,
    expiresAt: "2026-07-11T00:00:00.000Z",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  } as unknown as DispatchSensitiveRequest;
}

describe("ownerAppOAuthSensitiveRequestAdapter", () => {
  it("declares the canonical owner_app_oauth target", () => {
    expect(ownerAppOAuthSensitiveRequestAdapter.target).toBe("owner_app_oauth");
  });

  it("delivers to an owner-app private chat and emits the OAuth form envelope", async () => {
    const { runtime, calls } = makeRuntime();
    const request = makeOwnerAppPrivateOAuthRequest();

    const result = await ownerAppOAuthSensitiveRequestAdapter.deliver({
      request,
      channelId: "ch_owner_app",
      runtime,
    });

    expect(result).toEqual({
      delivered: true,
      target: "owner_app_oauth",
      formRendered: true,
      channelId: "ch_owner_app",
      expiresAt: request.expiresAt,
    });

    expect(calls).toHaveLength(1);
    const sent = calls[0];
    expect(sent.target.source).toBe("owner_app");
    expect(sent.target.channelId).toBe("ch_owner_app");
    expect(sent.target.roomId).toBe(ROOM_ID);
    expect(sent.target.entityId).toBe(ENTITY_ID);

    const envelope = sent.content.secretRequest as {
      requestId: string;
      provider: string;
      label?: string;
      scopes?: string[];
      expiresAt: string;
      status: string;
      delivery: {
        mode: string;
        canCollectValueInCurrentChannel: boolean;
        privateRouteRequired: boolean;
      };
      form: {
        type: string;
        kind: string;
        mode: string;
        fields: unknown[];
        provider: string;
        scopes?: string[];
        authorizationUrl: string;
        submitLabel: string;
        statusOnly: boolean;
      };
    };

    // Shape verified against packages/ui/src/components/chat/MessageContent.tsx
    // (OAuthRequestPanel) and packages/ui/src/api/client-types-chat.ts
    // (SensitiveRequestForm).
    expect(envelope.requestId).toBe(REQUEST_ID);
    expect(envelope.provider).toBe("github");
    expect(envelope.label).toBe("GitHub");
    expect(envelope.scopes).toEqual(["repo", "read:user"]);
    expect(envelope.status).toBe("pending");
    expect(envelope.expiresAt).toBe(request.expiresAt);
    expect(envelope.delivery.mode).toBe("inline_owner_app");
    expect(envelope.delivery.canCollectValueInCurrentChannel).toBe(true);
    expect(envelope.form.type).toBe("sensitive_request_form");
    expect(envelope.form.kind).toBe("oauth");
    expect(envelope.form.mode).toBe("inline_owner_app");
    expect(envelope.form.fields).toEqual([]);
    expect(envelope.form.provider).toBe("github");
    expect(envelope.form.scopes).toEqual(["repo", "read:user"]);
    expect(envelope.form.authorizationUrl).toBe(AUTHZ_URL);
    expect(envelope.form.submitLabel).toBe("Connect GitHub");
    expect(envelope.form.statusOnly).toBe(true);
  });

  it("does NOT include the authorization URL in the chat content text", async () => {
    const { runtime, calls } = makeRuntime();
    const request = makeOwnerAppPrivateOAuthRequest();

    await ownerAppOAuthSensitiveRequestAdapter.deliver({
      request,
      channelId: "ch_owner_app",
      runtime,
    });

    expect(calls).toHaveLength(1);
    const sent = calls[0];
    const text = (sent.content.text ?? "") as string;
    // The URL must only travel inside the envelope. Embedding it in `text`
    // would defeat the popup boundary.
    expect(text).not.toContain(AUTHZ_URL);
    expect(text).not.toContain("github.com/login/oauth");
    // The envelope itself still carries it.
    const envelope = sent.content.secretRequest as {
      form: { authorizationUrl: string };
    };
    expect(envelope.form.authorizationUrl).toBe(AUTHZ_URL);
  });

  it("falls back to provider when label is omitted", async () => {
    const { runtime, calls } = makeRuntime();
    const request = makeOwnerAppPrivateOAuthRequest({
      target: {
        kind: "oauth",
        provider: "google",
        authorizationUrl: "https://accounts.google.com/o/oauth2/auth?x=1",
      },
    } as unknown as Partial<DispatchSensitiveRequest>);

    await ownerAppOAuthSensitiveRequestAdapter.deliver({
      request,
      channelId: "ch_owner_app",
      runtime,
    });

    const envelope = calls[0].content.secretRequest as {
      label?: string;
      form: { submitLabel: string };
    };
    expect(envelope.label).toBe("google");
    expect(envelope.form.submitLabel).toBe("Connect google");
  });

  it("rejects delivery when the channel is not owner-app-private", async () => {
    const { runtime, calls } = makeRuntime();
    const request = makePublicOAuthRequest();

    const result = await ownerAppOAuthSensitiveRequestAdapter.deliver({
      request,
      channelId: "ch_discord_general",
      runtime,
    });

    expect(result).toEqual({
      delivered: false,
      target: "owner_app_oauth",
      error: "channel not owner-app-private",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects delivery when the request kind is not oauth", async () => {
    const { runtime, calls } = makeRuntime();
    const ownerRequest = makeOwnerAppPrivateOAuthRequest();
    const secretRequest: DispatchSensitiveRequest = {
      ...ownerRequest,
      kind: "secret",
      target: { kind: "secret", key: "OPENAI_API_KEY" },
    } as unknown as DispatchSensitiveRequest;

    const result = await ownerAppOAuthSensitiveRequestAdapter.deliver({
      request: secretRequest,
      channelId: "ch_owner_app",
      runtime,
    });

    expect(result.delivered).toBe(false);
    expect(result.error).toContain("kind=oauth only");
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed OAuth targets missing provider or authorizationUrl", async () => {
    const { runtime, calls } = makeRuntime();
    const malformed = makeOwnerAppPrivateOAuthRequest({
      target: {
        kind: "oauth",
      } as unknown as DispatchSensitiveRequest["target"],
    } as unknown as Partial<DispatchSensitiveRequest>);

    const result = await ownerAppOAuthSensitiveRequestAdapter.deliver({
      request: malformed,
      channelId: "ch_owner_app",
      runtime,
    });

    expect(result.delivered).toBe(false);
    expect(result.error).toContain("provider");
    expect(result.error).toContain("authorizationUrl");
    expect(calls).toHaveLength(0);
  });

  it("returns a dispatch error when the runtime lacks sendMessageToTarget", async () => {
    const result = await ownerAppOAuthSensitiveRequestAdapter.deliver({
      request: makeOwnerAppPrivateOAuthRequest(),
      channelId: "ch_owner_app",
      runtime: {},
    });

    expect(result).toEqual({
      delivered: false,
      target: "owner_app_oauth",
      error: "runtime missing sendMessageToTarget",
    });
  });

  it("surfaces sendMessageToTarget failures as dispatch errors", async () => {
    const runtime = {
      sendMessageToTarget: vi.fn(async () => {
        throw new Error("transport down");
      }),
    };
    const result = await ownerAppOAuthSensitiveRequestAdapter.deliver({
      request: makeOwnerAppPrivateOAuthRequest(),
      channelId: "ch_owner_app",
      runtime,
    });
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("dispatch failed");
    expect(result.error).toContain("transport down");
  });

  it("calls sendMessageToTarget exactly once with the envelope on secretRequest", async () => {
    const { runtime, calls } = makeRuntime();
    const sendSpy = runtime.sendMessageToTarget as ReturnType<typeof vi.fn>;
    await ownerAppOAuthSensitiveRequestAdapter.deliver({
      request: makeOwnerAppPrivateOAuthRequest(),
      channelId: "ch_owner_app",
      runtime,
    });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    const envelope = calls[0].content.secretRequest as { form?: unknown };
    expect(envelope).toBeDefined();
    expect((envelope.form as { kind: string }).kind).toBe("oauth");
  });
});
