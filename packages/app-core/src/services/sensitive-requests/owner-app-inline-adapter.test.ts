import {
  ChannelType,
  type Content,
  defaultSensitiveRequestPolicy,
  type DispatchSensitiveRequest,
  resolveSensitiveRequestDelivery,
  type SensitiveRequest,
  type TargetInfo,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { ownerAppInlineSensitiveRequestAdapter } from "./owner-app-inline-adapter";

const REQUEST_ID = "req_test_123";
const ROOM_ID = "11111111-1111-1111-1111-111111111111";
const ENTITY_ID = "22222222-2222-2222-2222-222222222222";
type TestSensitiveRequest = SensitiveRequest & DispatchSensitiveRequest;

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

function makeOwnerAppPrivateRequest(): TestSensitiveRequest {
  const delivery = resolveSensitiveRequestDelivery({
    kind: "secret",
    environment: { ownerApp: { privateChat: true } },
  });
  return {
    id: REQUEST_ID,
    kind: "secret",
    status: "pending",
    agentId: "agent-1",
    ownerEntityId: ENTITY_ID,
    sourceRoomId: ROOM_ID,
    sourceChannelType: ChannelType.DM,
    sourcePlatform: "owner_app",
    target: { kind: "secret", key: "OPENAI_API_KEY" },
    policy: defaultSensitiveRequestPolicy("secret"),
    delivery,
    expiresAt: "2026-05-11T00:00:00.000Z",
    createdAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:00.000Z",
  } as TestSensitiveRequest;
}

function makePublicRequest(): TestSensitiveRequest {
  const delivery = resolveSensitiveRequestDelivery({
    kind: "secret",
    channelType: ChannelType.GROUP,
    environment: { ownerApp: { privateChat: false } },
  });
  return {
    id: "req_pub",
    kind: "secret",
    status: "pending",
    agentId: "agent-1",
    ownerEntityId: ENTITY_ID,
    sourceRoomId: ROOM_ID,
    sourceChannelType: ChannelType.GROUP,
    sourcePlatform: "discord",
    target: { kind: "secret", key: "OPENAI_API_KEY" },
    policy: defaultSensitiveRequestPolicy("secret"),
    delivery,
    expiresAt: "2026-05-11T00:00:00.000Z",
    createdAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:00.000Z",
  } as TestSensitiveRequest;
}

describe("ownerAppInlineSensitiveRequestAdapter", () => {
  it("declares the canonical owner_app_inline target", () => {
    expect(ownerAppInlineSensitiveRequestAdapter.target).toBe(
      "owner_app_inline",
    );
  });

  it("delivers to an owner-app private chat and emits the inline form envelope", async () => {
    const { runtime, calls } = makeRuntime();
    const request = makeOwnerAppPrivateRequest();

    const result = await ownerAppInlineSensitiveRequestAdapter.deliver({
      request,
      channelId: "ch_owner_app",
      runtime,
    });

    expect(result).toEqual({
      delivered: true,
      target: "owner_app_inline",
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
      key: string;
      label: string;
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
        submitLabel: string;
        statusOnly: boolean;
        fields: Array<{
          name: string;
          label?: string;
          input: string;
          required: boolean;
        }>;
      };
    };

    // Shape verified against packages/ui/src/components/chat/MessageContent.tsx
    // (SensitiveRequestBlock) and packages/ui/src/api/client-types-chat.ts
    // (ConversationSecretRequest).
    expect(envelope.requestId).toBe(REQUEST_ID);
    expect(envelope.key).toBe("OPENAI_API_KEY");
    expect(envelope.label).toBe("OPENAI_API_KEY");
    expect(envelope.status).toBe("pending");
    expect(envelope.expiresAt).toBe(request.expiresAt);
    expect(envelope.delivery.mode).toBe("inline_owner_app");
    expect(envelope.delivery.canCollectValueInCurrentChannel).toBe(true);
    expect(envelope.delivery.privateRouteRequired).toBe(true);
    expect(envelope.form.type).toBe("sensitive_request_form");
    expect(envelope.form.kind).toBe("secret");
    expect(envelope.form.mode).toBe("inline_owner_app");
    expect(envelope.form.submitLabel).toBe("Save secret");
    expect(envelope.form.statusOnly).toBe(true);
    expect(envelope.form.fields).toEqual([
      {
        name: "OPENAI_API_KEY",
        label: "OPENAI_API_KEY",
        input: "secret",
        required: true,
      },
    ]);
  });

  it("rejects delivery when the channel is not owner-app-private", async () => {
    const { runtime, calls } = makeRuntime();
    const request = makePublicRequest();

    const result = await ownerAppInlineSensitiveRequestAdapter.deliver({
      request,
      channelId: "ch_discord_general",
      runtime,
    });

    expect(result).toEqual({
      delivered: false,
      target: "owner_app_inline",
      error: "channel not owner-app-private",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects delivery when the request kind is not secret", async () => {
    const { runtime, calls } = makeRuntime();
    const ownerRequest = makeOwnerAppPrivateRequest();
    const oauthRequest: TestSensitiveRequest = {
      ...ownerRequest,
      kind: "oauth",
      target: { kind: "oauth" },
    } as TestSensitiveRequest;

    const result = await ownerAppInlineSensitiveRequestAdapter.deliver({
      request: oauthRequest,
      channelId: "ch_owner_app",
      runtime,
    });

    expect(result.delivered).toBe(false);
    expect(result.error).toContain("kind=secret only");
    expect(calls).toHaveLength(0);
  });

  it("returns a dispatch error when the runtime lacks sendMessageToTarget", async () => {
    const result = await ownerAppInlineSensitiveRequestAdapter.deliver({
      request: makeOwnerAppPrivateRequest(),
      channelId: "ch_owner_app",
      runtime: {},
    });

    expect(result).toEqual({
      delivered: false,
      target: "owner_app_inline",
      error: "runtime missing sendMessageToTarget",
    });
  });

  it("surfaces sendMessageToTarget failures as dispatch errors", async () => {
    const runtime = {
      sendMessageToTarget: vi.fn(async () => {
        throw new Error("transport down");
      }),
    };
    const result = await ownerAppInlineSensitiveRequestAdapter.deliver({
      request: makeOwnerAppPrivateRequest(),
      channelId: "ch_owner_app",
      runtime,
    });
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("dispatch failed");
    expect(result.error).toContain("transport down");
  });
});
