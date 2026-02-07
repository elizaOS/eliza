/**
 * Comprehensive tests for the Zalo User plugin (TypeScript).
 *
 * Covers:
 * - Plugin metadata (name, 7 actions, 1 provider, 1 service)
 * - Constants and defaults
 * - Environment schema and config validation
 * - buildZaloUserSettings mapping
 * - All 7 actions: metadata, validate(), handler error paths
 * - chatStateProvider metadata and get() behavior
 * - ZaloUserEventTypes enum values
 */

import { describe, expect, it, vi } from "vitest";

import zaloUserPlugin, {
  buildZaloUserSettings,
  CHAT_STATE_PROVIDER,
  chatStateProvider,
  CHECK_STATUS_ACTION,
  checkStatusAction,
  GET_PROFILE_ACTION,
  getProfileAction,
  LIST_FRIENDS_ACTION,
  listFriendsAction,
  LIST_GROUPS_ACTION,
  listGroupsAction,
  SEND_IMAGE_ACTION,
  sendImageAction,
  SEND_LINK_ACTION,
  sendLinkAction,
  SEND_MESSAGE_ACTION,
  sendMessageAction,
  ZALOUSER_SERVICE_NAME,
  ZaloUserEventTypes,
  ZaloUserService,
} from "../index";

import {
  DEFAULT_PROFILE,
  DEFAULT_ZCA_TIMEOUT,
  MAX_MESSAGE_LENGTH,
  ZCA_BINARY,
} from "../constants";

import { zaloUserEnvSchema } from "../environment";

// ══════════════════════════════════════════════════════════════════
// 1. Plugin metadata
// ══════════════════════════════════════════════════════════════════

describe("zaloUserPlugin metadata", () => {
  it("has the correct name", () => {
    expect(zaloUserPlugin.name).toBe("zalouser");
  });

  it("has a non-empty description", () => {
    expect(zaloUserPlugin.description).toBeTruthy();
  });

  it("exports 7 actions", () => {
    expect(zaloUserPlugin.actions).toHaveLength(7);
  });

  it("exports one provider", () => {
    expect(zaloUserPlugin.providers).toHaveLength(1);
  });

  it("exports one service", () => {
    expect(zaloUserPlugin.services).toHaveLength(1);
    expect(zaloUserPlugin.services![0]).toBe(ZaloUserService);
  });

  it("actions include all expected names", () => {
    const names = zaloUserPlugin.actions!.map((a) => a.name);
    expect(names).toContain(SEND_MESSAGE_ACTION);
    expect(names).toContain(SEND_IMAGE_ACTION);
    expect(names).toContain(SEND_LINK_ACTION);
    expect(names).toContain(LIST_FRIENDS_ACTION);
    expect(names).toContain(LIST_GROUPS_ACTION);
    expect(names).toContain(GET_PROFILE_ACTION);
    expect(names).toContain(CHECK_STATUS_ACTION);
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. Constants
// ══════════════════════════════════════════════════════════════════

describe("constants", () => {
  it("ZALOUSER_SERVICE_NAME is 'zalouser'", () => {
    expect(ZALOUSER_SERVICE_NAME).toBe("zalouser");
  });

  it("MAX_MESSAGE_LENGTH is 2000", () => {
    expect(MAX_MESSAGE_LENGTH).toBe(2000);
  });

  it("DEFAULT_ZCA_TIMEOUT is positive", () => {
    expect(DEFAULT_ZCA_TIMEOUT).toBeGreaterThan(0);
  });

  it("ZCA_BINARY is 'zca'", () => {
    expect(ZCA_BINARY).toBe("zca");
  });

  it("DEFAULT_PROFILE is 'default'", () => {
    expect(DEFAULT_PROFILE).toBe("default");
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. ZaloUserEventTypes
// ══════════════════════════════════════════════════════════════════

describe("ZaloUserEventTypes", () => {
  it("has all expected event types", () => {
    const expected = [
      "WORLD_JOINED",
      "WORLD_CONNECTED",
      "WORLD_LEFT",
      "ENTITY_JOINED",
      "ENTITY_LEFT",
      "ENTITY_UPDATED",
      "MESSAGE_RECEIVED",
      "MESSAGE_SENT",
      "REACTION_RECEIVED",
      "REACTION_SENT",
      "QR_CODE_READY",
      "LOGIN_SUCCESS",
      "LOGIN_FAILED",
      "CLIENT_STARTED",
      "CLIENT_STOPPED",
    ];
    for (const key of expected) {
      expect(ZaloUserEventTypes).toHaveProperty(key);
    }
  });

  it("values are prefixed with ZALOUSER_", () => {
    for (const value of Object.values(ZaloUserEventTypes)) {
      expect(value).toMatch(/^ZALOUSER_/);
    }
  });

  it("MESSAGE_RECEIVED has correct value", () => {
    expect(ZaloUserEventTypes.MESSAGE_RECEIVED).toBe(
      "ZALOUSER_MESSAGE_RECEIVED",
    );
  });

  it("QR_CODE_READY has correct value", () => {
    expect(ZaloUserEventTypes.QR_CODE_READY).toBe("ZALOUSER_QR_CODE_READY");
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. Environment schema
// ══════════════════════════════════════════════════════════════════

describe("zaloUserEnvSchema", () => {
  it("accepts empty object (all optional)", () => {
    const result = zaloUserEnvSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("defaults ZALOUSER_ENABLED to true", () => {
    const result = zaloUserEnvSchema.parse({});
    expect(result.ZALOUSER_ENABLED).toBe(true);
  });

  it("defaults ZALOUSER_DEFAULT_PROFILE to 'default'", () => {
    const result = zaloUserEnvSchema.parse({});
    expect(result.ZALOUSER_DEFAULT_PROFILE).toBe("default");
  });

  it("defaults ZALOUSER_LISTEN_TIMEOUT to 30000", () => {
    const result = zaloUserEnvSchema.parse({});
    expect(result.ZALOUSER_LISTEN_TIMEOUT).toBe(30000);
  });

  it("defaults ZALOUSER_DM_POLICY to 'pairing'", () => {
    const result = zaloUserEnvSchema.parse({});
    expect(result.ZALOUSER_DM_POLICY).toBe("pairing");
  });

  it("defaults ZALOUSER_GROUP_POLICY to 'disabled'", () => {
    const result = zaloUserEnvSchema.parse({});
    expect(result.ZALOUSER_GROUP_POLICY).toBe("disabled");
  });

  it("rejects invalid DM policy", () => {
    const result = zaloUserEnvSchema.safeParse({
      ZALOUSER_DM_POLICY: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid group policy", () => {
    const result = zaloUserEnvSchema.safeParse({
      ZALOUSER_GROUP_POLICY: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all valid DM policies", () => {
    for (const policy of ["open", "allowlist", "pairing", "disabled"]) {
      const result = zaloUserEnvSchema.safeParse({
        ZALOUSER_DM_POLICY: policy,
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts all valid group policies", () => {
    for (const policy of ["open", "allowlist", "disabled"]) {
      const result = zaloUserEnvSchema.safeParse({
        ZALOUSER_GROUP_POLICY: policy,
      });
      expect(result.success).toBe(true);
    }
  });

  it("coerces ZALOUSER_LISTEN_TIMEOUT string to number", () => {
    const result = zaloUserEnvSchema.parse({
      ZALOUSER_LISTEN_TIMEOUT: "60000",
    });
    expect(result.ZALOUSER_LISTEN_TIMEOUT).toBe(60000);
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. buildZaloUserSettings
// ══════════════════════════════════════════════════════════════════

describe("buildZaloUserSettings", () => {
  const baseConfig = zaloUserEnvSchema.parse({});

  it("defaults enabled to true", () => {
    const s = buildZaloUserSettings(baseConfig);
    expect(s.enabled).toBe(true);
  });

  it("defaults defaultProfile to 'default'", () => {
    const s = buildZaloUserSettings(baseConfig);
    expect(s.defaultProfile).toBe("default");
  });

  it("defaults dmPolicy to 'pairing'", () => {
    const s = buildZaloUserSettings(baseConfig);
    expect(s.dmPolicy).toBe("pairing");
  });

  it("defaults groupPolicy to 'disabled'", () => {
    const s = buildZaloUserSettings(baseConfig);
    expect(s.groupPolicy).toBe("disabled");
  });

  it("defaults allowedThreads to empty array", () => {
    const s = buildZaloUserSettings(baseConfig);
    expect(s.allowedThreads).toEqual([]);
  });

  it("parses JSON array allowed threads", () => {
    const config = zaloUserEnvSchema.parse({
      ZALOUSER_ALLOWED_THREADS: '["t1", "t2"]',
    });
    const s = buildZaloUserSettings(config);
    expect(s.allowedThreads).toEqual(["t1", "t2"]);
  });

  it("parses comma-separated allowed threads", () => {
    const config = zaloUserEnvSchema.parse({
      ZALOUSER_ALLOWED_THREADS: "t1, t2, t3",
    });
    const s = buildZaloUserSettings(config);
    expect(s.allowedThreads).toEqual(["t1", "t2", "t3"]);
  });
});

// ══════════════════════════════════════════════════════════════════
// 6. sendMessageAction
// ══════════════════════════════════════════════════════════════════

describe("sendMessageAction", () => {
  it("has the correct name", () => {
    expect(sendMessageAction.name).toBe("SEND_ZALOUSER_MESSAGE");
  });

  it("has similes", () => {
    expect(sendMessageAction.similes!.length).toBeGreaterThanOrEqual(1);
  });

  it("has a description", () => {
    expect(sendMessageAction.description).toBeTruthy();
  });

  it("has examples", () => {
    expect(sendMessageAction.examples!.length).toBeGreaterThanOrEqual(1);
  });

  describe("validate()", () => {
    it("returns true for source 'zalouser'", async () => {
      const msg = { content: { source: "zalouser" } } as any;
      expect(await sendMessageAction.validate({} as any, msg)).toBe(true);
    });

    it("returns false for source 'zalo'", async () => {
      const msg = { content: { source: "zalo" } } as any;
      expect(await sendMessageAction.validate({} as any, msg)).toBe(false);
    });

    it("returns false for undefined source", async () => {
      const msg = { content: {} } as any;
      expect(await sendMessageAction.validate({} as any, msg)).toBe(false);
    });
  });

  describe("handler() error paths", () => {
    it("returns error when service not available", async () => {
      const runtime = { getService: () => undefined } as any;
      const msg = { content: {} } as any;
      const cb = vi.fn();
      const result = await sendMessageAction.handler(
        runtime,
        msg,
        undefined,
        undefined,
        cb,
      );
      expect(result).toEqual({
        success: false,
        error: "Zalo User service not initialized",
      });
    });

    it("returns error when threadId missing", async () => {
      const runtime = {
        getService: () => ({ sendMessage: vi.fn() }),
        composeState: vi.fn().mockResolvedValue({ values: {} }),
      } as any;
      const msg = { content: { source: "zalouser" } } as any;
      const cb = vi.fn();
      const result = await sendMessageAction.handler(
        runtime,
        msg,
        undefined,
        undefined,
        cb,
      );
      expect(result).toEqual({
        success: false,
        error: "Missing thread ID",
      });
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// 7. sendImageAction
// ══════════════════════════════════════════════════════════════════

describe("sendImageAction", () => {
  it("has the correct name", () => {
    expect(sendImageAction.name).toBe("SEND_ZALOUSER_IMAGE");
  });

  it("has similes", () => {
    expect(sendImageAction.similes!.length).toBeGreaterThanOrEqual(1);
  });

  it("has a description", () => {
    expect(sendImageAction.description).toBeTruthy();
  });

  describe("validate()", () => {
    it("returns true for source 'zalouser'", async () => {
      const msg = { content: { source: "zalouser" } } as any;
      expect(await sendImageAction.validate({} as any, msg)).toBe(true);
    });

    it("returns false for other sources", async () => {
      const msg = { content: { source: "discord" } } as any;
      expect(await sendImageAction.validate({} as any, msg)).toBe(false);
    });
  });

  describe("handler() error paths", () => {
    it("returns error when service not available", async () => {
      const runtime = { getService: () => undefined } as any;
      const msg = { content: {} } as any;
      const cb = vi.fn();
      const result = await sendImageAction.handler(
        runtime,
        msg,
        undefined,
        undefined,
        cb,
      );
      expect(result).toEqual({
        success: false,
        error: "Zalo User service not initialized",
      });
    });

    it("returns error when threadId missing", async () => {
      const runtime = { getService: () => ({}) } as any;
      const msg = { content: { url: "https://img.jpg" } } as any;
      const cb = vi.fn();
      const result = await sendImageAction.handler(
        runtime,
        msg,
        undefined,
        undefined,
        cb,
      );
      expect(result).toEqual({
        success: false,
        error: "Missing thread ID",
      });
    });

    it("returns error when image URL missing", async () => {
      const runtime = { getService: () => ({}) } as any;
      const msg = { content: { threadId: "t1" } } as any;
      const cb = vi.fn();
      const result = await sendImageAction.handler(
        runtime,
        msg,
        undefined,
        undefined,
        cb,
      );
      expect(result).toEqual({
        success: false,
        error: "Missing image URL",
      });
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// 8. sendLinkAction
// ══════════════════════════════════════════════════════════════════

describe("sendLinkAction", () => {
  it("has the correct name", () => {
    expect(sendLinkAction.name).toBe("SEND_ZALOUSER_LINK");
  });

  it("has similes", () => {
    expect(sendLinkAction.similes!.length).toBeGreaterThanOrEqual(1);
  });

  describe("validate()", () => {
    it("returns true for source 'zalouser'", async () => {
      const msg = { content: { source: "zalouser" } } as any;
      expect(await sendLinkAction.validate({} as any, msg)).toBe(true);
    });

    it("returns false for other sources", async () => {
      const msg = { content: { source: "slack" } } as any;
      expect(await sendLinkAction.validate({} as any, msg)).toBe(false);
    });
  });

  describe("handler() error paths", () => {
    it("returns error when service not available", async () => {
      const runtime = { getService: () => undefined } as any;
      const cb = vi.fn();
      const result = await sendLinkAction.handler(
        runtime,
        { content: {} } as any,
        undefined,
        undefined,
        cb,
      );
      expect(result).toEqual({
        success: false,
        error: "Zalo User service not initialized",
      });
    });

    it("returns error when URL missing", async () => {
      const runtime = { getService: () => ({}) } as any;
      const msg = { content: { threadId: "t1" } } as any;
      const cb = vi.fn();
      const result = await sendLinkAction.handler(
        runtime,
        msg,
        undefined,
        undefined,
        cb,
      );
      expect(result).toEqual({
        success: false,
        error: "Missing URL",
      });
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// 9. getProfileAction
// ══════════════════════════════════════════════════════════════════

describe("getProfileAction", () => {
  it("has the correct name", () => {
    expect(getProfileAction.name).toBe("ZALOUSER_GET_PROFILE");
  });

  it("has similes", () => {
    expect(getProfileAction.similes!.length).toBeGreaterThanOrEqual(1);
  });

  it("has a description", () => {
    expect(getProfileAction.description).toBeTruthy();
  });

  describe("validate()", () => {
    it("returns true when service exists", async () => {
      const runtime = { getService: () => ({}) } as any;
      expect(
        await getProfileAction.validate(runtime, {} as any),
      ).toBe(true);
    });

    it("returns false when service missing", async () => {
      const runtime = { getService: () => undefined } as any;
      expect(
        await getProfileAction.validate(runtime, {} as any),
      ).toBe(false);
    });
  });

  describe("handler() error paths", () => {
    it("returns error when service not available", async () => {
      const runtime = { getService: () => undefined } as any;
      const cb = vi.fn();
      const result = await getProfileAction.handler(
        runtime,
        {} as any,
        undefined,
        undefined,
        cb,
      );
      expect(result).toEqual({
        success: false,
        error: "Zalo User service not initialized",
      });
    });

    it("returns error when not authenticated", async () => {
      const runtime = {
        getService: () => ({ getCurrentUser: () => null }),
      } as any;
      const cb = vi.fn();
      const result = await getProfileAction.handler(
        runtime,
        {} as any,
        undefined,
        undefined,
        cb,
      );
      expect(result).toEqual({
        success: false,
        error: "Not authenticated",
      });
    });

    it("returns success with user info", async () => {
      const runtime = {
        getService: () => ({
          getCurrentUser: () => ({
            userId: "u1",
            displayName: "Alice",
            avatar: "https://avatar.jpg",
          }),
        }),
      } as any;
      const cb = vi.fn();
      const result = await getProfileAction.handler(
        runtime,
        {} as any,
        undefined,
        undefined,
        cb,
      );
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        action: GET_PROFILE_ACTION,
        userId: "u1",
        displayName: "Alice",
      });
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// 10. listFriendsAction
// ══════════════════════════════════════════════════════════════════

describe("listFriendsAction", () => {
  it("has the correct name", () => {
    expect(listFriendsAction.name).toBe("ZALOUSER_LIST_FRIENDS");
  });

  it("has similes", () => {
    expect(listFriendsAction.similes!.length).toBeGreaterThanOrEqual(1);
  });

  describe("validate()", () => {
    it("returns true when service exists", async () => {
      const runtime = { getService: () => ({}) } as any;
      expect(
        await listFriendsAction.validate(runtime, {} as any),
      ).toBe(true);
    });

    it("returns false when service missing", async () => {
      const runtime = { getService: () => undefined } as any;
      expect(
        await listFriendsAction.validate(runtime, {} as any),
      ).toBe(false);
    });
  });

  describe("handler() error paths", () => {
    it("returns error when service not available", async () => {
      const runtime = { getService: () => undefined } as any;
      const cb = vi.fn();
      const result = await listFriendsAction.handler(
        runtime,
        { content: {} } as any,
        undefined,
        undefined,
        cb,
      );
      expect(result).toEqual({
        success: false,
        error: "Zalo User service not initialized",
      });
    });

    it("returns empty list when no friends", async () => {
      const runtime = {
        getService: () => ({
          listFriends: vi.fn().mockResolvedValue([]),
        }),
      } as any;
      const cb = vi.fn();
      const result = await listFriendsAction.handler(
        runtime,
        { content: {} } as any,
        undefined,
        undefined,
        cb,
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ friends: [] });
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// 11. listGroupsAction
// ══════════════════════════════════════════════════════════════════

describe("listGroupsAction", () => {
  it("has the correct name", () => {
    expect(listGroupsAction.name).toBe("ZALOUSER_LIST_GROUPS");
  });

  it("has similes", () => {
    expect(listGroupsAction.similes!.length).toBeGreaterThanOrEqual(1);
  });

  describe("validate()", () => {
    it("returns true when service exists", async () => {
      const runtime = { getService: () => ({}) } as any;
      expect(
        await listGroupsAction.validate(runtime, {} as any),
      ).toBe(true);
    });
  });

  describe("handler() error paths", () => {
    it("returns error when service not available", async () => {
      const runtime = { getService: () => undefined } as any;
      const cb = vi.fn();
      const result = await listGroupsAction.handler(
        runtime,
        {} as any,
        undefined,
        undefined,
        cb,
      );
      expect(result).toEqual({
        success: false,
        error: "Zalo User service not initialized",
      });
    });

    it("returns empty list when no groups", async () => {
      const runtime = {
        getService: () => ({
          listGroups: vi.fn().mockResolvedValue([]),
        }),
      } as any;
      const cb = vi.fn();
      const result = await listGroupsAction.handler(
        runtime,
        {} as any,
        undefined,
        undefined,
        cb,
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ groups: [] });
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// 12. checkStatusAction
// ══════════════════════════════════════════════════════════════════

describe("checkStatusAction", () => {
  it("has the correct name", () => {
    expect(checkStatusAction.name).toBe("ZALOUSER_CHECK_STATUS");
  });

  it("has similes", () => {
    expect(checkStatusAction.similes!.length).toBeGreaterThanOrEqual(1);
  });

  describe("validate()", () => {
    it("returns true when service exists", async () => {
      const runtime = { getService: () => ({}) } as any;
      expect(
        await checkStatusAction.validate(runtime, {} as any),
      ).toBe(true);
    });

    it("returns false when service missing", async () => {
      const runtime = { getService: () => undefined } as any;
      expect(
        await checkStatusAction.validate(runtime, {} as any),
      ).toBe(false);
    });
  });

  describe("handler() error paths", () => {
    it("returns error when service not available", async () => {
      const runtime = { getService: () => undefined } as any;
      const cb = vi.fn();
      const result = await checkStatusAction.handler(
        runtime,
        {} as any,
        undefined,
        undefined,
        cb,
      );
      expect(result).toEqual({
        success: false,
        error: "Zalo User service not initialized",
      });
    });

    it("returns disconnected status on probe failure", async () => {
      const runtime = {
        getService: () => ({
          probeZaloUser: vi
            .fn()
            .mockResolvedValue({ ok: false, error: "timeout", latencyMs: 5000 }),
          isRunning: () => false,
        }),
      } as any;
      const cb = vi.fn();
      const result = await checkStatusAction.handler(
        runtime,
        {} as any,
        undefined,
        undefined,
        cb,
      );
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        connected: false,
        error: "timeout",
      });
    });

    it("returns connected status on probe success", async () => {
      const runtime = {
        getService: () => ({
          probeZaloUser: vi.fn().mockResolvedValue({
            ok: true,
            user: { id: "u1", displayName: "Alice" },
            latencyMs: 42,
          }),
          isRunning: () => true,
        }),
      } as any;
      const cb = vi.fn();
      const result = await checkStatusAction.handler(
        runtime,
        {} as any,
        undefined,
        undefined,
        cb,
      );
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        connected: true,
        running: true,
      });
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// 13. chatStateProvider
// ══════════════════════════════════════════════════════════════════

describe("chatStateProvider", () => {
  it("has the correct name", () => {
    expect(chatStateProvider.name).toBe("zalouser_chat_state");
  });

  it("CHAT_STATE_PROVIDER constant matches", () => {
    expect(CHAT_STATE_PROVIDER).toBe("zalouser_chat_state");
  });

  it("has a description", () => {
    expect(chatStateProvider.description).toBeTruthy();
  });

  it("is marked as dynamic", () => {
    expect(chatStateProvider.dynamic).toBe(true);
  });

  describe("get()", () => {
    it("returns threadId from message content", async () => {
      const msg = {
        content: { threadId: "t-1", isGroup: false },
        roomId: "r-1",
      } as any;
      const result = await chatStateProvider.get({} as any, msg, {} as any);
      expect(result.data.threadId).toBe("t-1");
      expect(result.values.thread_id).toBe("t-1");
    });

    it("returns isPrivate=true for non-group", async () => {
      const msg = {
        content: { threadId: "t-1", isGroup: false },
        roomId: "r-1",
      } as any;
      const result = await chatStateProvider.get({} as any, msg, {} as any);
      expect(result.data.isPrivate).toBe(true);
      expect(result.data.isGroup).toBe(false);
    });

    it("returns isGroup=true for group", async () => {
      const msg = {
        content: { threadId: "t-1", isGroup: true },
        roomId: "r-1",
      } as any;
      const result = await chatStateProvider.get({} as any, msg, {} as any);
      expect(result.data.isGroup).toBe(true);
      expect(result.data.isPrivate).toBe(false);
    });

    it("includes senderId in values", async () => {
      const msg = {
        content: { senderId: "s-1" },
        roomId: "r-1",
      } as any;
      const result = await chatStateProvider.get({} as any, msg, {} as any);
      expect(result.values.sender_id).toBe("s-1");
    });

    it("text contains header", async () => {
      const msg = { content: {}, roomId: "r-1" } as any;
      const result = await chatStateProvider.get({} as any, msg, {} as any);
      expect(result.text).toContain("Zalo User Chat State");
    });

    it("text includes thread info when present", async () => {
      const msg = {
        content: { threadId: "t-99", isGroup: true },
        roomId: "r-1",
      } as any;
      const result = await chatStateProvider.get({} as any, msg, {} as any);
      expect(result.text).toContain("t-99");
      expect(result.text).toContain("Group");
    });
  });
});
