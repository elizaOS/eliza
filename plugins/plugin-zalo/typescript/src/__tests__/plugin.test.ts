/**
 * Comprehensive tests for the Zalo Official Account plugin (TypeScript).
 *
 * Covers:
 * - Plugin metadata (name, description, actions, providers, services)
 * - Constants and defaults
 * - Environment schema and config validation
 * - buildZaloSettings mapping
 * - sendMessageAction metadata, validate(), handler error paths
 * - chatStateProvider metadata and get() behavior
 * - Type re-exports / ZaloEventTypes enum values
 */

import { describe, expect, it, vi } from "vitest";

// ── Plugin entry ──────────────────────────────────────────────────
import zaloPlugin, {
  buildZaloSettings,
  CHAT_STATE_PROVIDER,
  chatStateProvider,
  SEND_MESSAGE_ACTION,
  sendMessageAction,
  validateZaloConfig,
  ZALO_SERVICE_NAME,
  ZaloEventTypes,
  ZaloService,
} from "../index";

import {
  DEFAULT_POLLING_TIMEOUT,
  DEFAULT_WEBHOOK_PATH,
  DEFAULT_WEBHOOK_PORT,
  MAX_MESSAGE_LENGTH,
  ZALO_OA_API_BASE,
  ZALO_OAUTH_API_BASE,
} from "../constants";

import { zaloEnvSchema, type ZaloConfig } from "../environment";

// ══════════════════════════════════════════════════════════════════
// 1. Plugin metadata
// ══════════════════════════════════════════════════════════════════

describe("zaloPlugin metadata", () => {
  it("has the correct name", () => {
    expect(zaloPlugin.name).toBe("zalo");
  });

  it("has a non-empty description", () => {
    expect(zaloPlugin.description).toBeTruthy();
    expect(typeof zaloPlugin.description).toBe("string");
  });

  it("exports one action (sendMessage)", () => {
    expect(zaloPlugin.actions).toHaveLength(1);
    expect(zaloPlugin.actions![0].name).toBe(SEND_MESSAGE_ACTION);
  });

  it("exports one provider (chatState)", () => {
    expect(zaloPlugin.providers).toHaveLength(1);
    expect(zaloPlugin.providers![0].name).toBe(CHAT_STATE_PROVIDER);
  });

  it("exports one service (ZaloService)", () => {
    expect(zaloPlugin.services).toHaveLength(1);
    expect(zaloPlugin.services![0]).toBe(ZaloService);
  });

  it("default export equals named export", () => {
    expect(zaloPlugin).toBeDefined();
    expect(zaloPlugin.name).toBe(ZALO_SERVICE_NAME);
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. Constants
// ══════════════════════════════════════════════════════════════════

describe("constants", () => {
  it("ZALO_SERVICE_NAME is 'zalo'", () => {
    expect(ZALO_SERVICE_NAME).toBe("zalo");
  });

  it("API base URLs are well-formed HTTPS URLs", () => {
    expect(ZALO_OA_API_BASE).toMatch(/^https:\/\/.+/);
    expect(ZALO_OAUTH_API_BASE).toMatch(/^https:\/\/.+/);
  });

  it("MAX_MESSAGE_LENGTH is a positive number", () => {
    expect(MAX_MESSAGE_LENGTH).toBe(2000);
  });

  it("DEFAULT_POLLING_TIMEOUT is a positive number", () => {
    expect(DEFAULT_POLLING_TIMEOUT).toBeGreaterThan(0);
  });

  it("DEFAULT_WEBHOOK_PATH starts with /", () => {
    expect(DEFAULT_WEBHOOK_PATH).toBe("/zalo/webhook");
  });

  it("DEFAULT_WEBHOOK_PORT is 3000", () => {
    expect(DEFAULT_WEBHOOK_PORT).toBe(3000);
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. ZaloEventTypes enum
// ══════════════════════════════════════════════════════════════════

describe("ZaloEventTypes", () => {
  it("has all expected event types", () => {
    const expected = [
      "BOT_STARTED",
      "BOT_STOPPED",
      "MESSAGE_RECEIVED",
      "MESSAGE_SENT",
      "WEBHOOK_REGISTERED",
      "USER_FOLLOWED",
      "USER_UNFOLLOWED",
      "TOKEN_REFRESHED",
    ];
    for (const key of expected) {
      expect(ZaloEventTypes).toHaveProperty(key);
    }
  });

  it("values are prefixed with ZALO_", () => {
    for (const value of Object.values(ZaloEventTypes)) {
      expect(value).toMatch(/^ZALO_/);
    }
  });

  it("BOT_STARTED has correct value", () => {
    expect(ZaloEventTypes.BOT_STARTED).toBe("ZALO_BOT_STARTED");
  });

  it("MESSAGE_RECEIVED has correct value", () => {
    expect(ZaloEventTypes.MESSAGE_RECEIVED).toBe("ZALO_MESSAGE_RECEIVED");
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. Environment schema & validateZaloConfig
// ══════════════════════════════════════════════════════════════════

describe("zaloEnvSchema", () => {
  it("accepts valid required fields", () => {
    const result = zaloEnvSchema.safeParse({
      ZALO_APP_ID: "my-app",
      ZALO_SECRET_KEY: "my-secret",
      ZALO_ACCESS_TOKEN: "my-token",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty ZALO_APP_ID", () => {
    const result = zaloEnvSchema.safeParse({
      ZALO_APP_ID: "",
      ZALO_SECRET_KEY: "key",
      ZALO_ACCESS_TOKEN: "tok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing ZALO_SECRET_KEY", () => {
    const result = zaloEnvSchema.safeParse({
      ZALO_APP_ID: "app",
      ZALO_ACCESS_TOKEN: "tok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing ZALO_ACCESS_TOKEN", () => {
    const result = zaloEnvSchema.safeParse({
      ZALO_APP_ID: "app",
      ZALO_SECRET_KEY: "key",
    });
    expect(result.success).toBe(false);
  });

  it("defaults ZALO_USE_POLLING to false", () => {
    const result = zaloEnvSchema.parse({
      ZALO_APP_ID: "app",
      ZALO_SECRET_KEY: "key",
      ZALO_ACCESS_TOKEN: "tok",
    });
    expect(result.ZALO_USE_POLLING).toBe(false);
  });

  it("defaults ZALO_ENABLED to true", () => {
    const result = zaloEnvSchema.parse({
      ZALO_APP_ID: "app",
      ZALO_SECRET_KEY: "key",
      ZALO_ACCESS_TOKEN: "tok",
    });
    expect(result.ZALO_ENABLED).toBe(true);
  });

  it("coerces ZALO_WEBHOOK_PORT string to number", () => {
    const result = zaloEnvSchema.parse({
      ZALO_APP_ID: "app",
      ZALO_SECRET_KEY: "key",
      ZALO_ACCESS_TOKEN: "tok",
      ZALO_WEBHOOK_PORT: "8443",
    });
    expect(result.ZALO_WEBHOOK_PORT).toBe(8443);
  });

  it("rejects invalid ZALO_WEBHOOK_URL", () => {
    const result = zaloEnvSchema.safeParse({
      ZALO_APP_ID: "app",
      ZALO_SECRET_KEY: "key",
      ZALO_ACCESS_TOKEN: "tok",
      ZALO_WEBHOOK_URL: "not-a-url",
    });
    expect(result.success).toBe(false);
  });
});

describe("validateZaloConfig", () => {
  const makeRuntime = (settings: Record<string, string | undefined>) =>
    ({
      getSetting: (key: string) => settings[key] ?? null,
    }) as any;

  it("returns parsed config when all required settings present", async () => {
    const runtime = makeRuntime({
      ZALO_APP_ID: "app",
      ZALO_SECRET_KEY: "secret",
      ZALO_ACCESS_TOKEN: "token",
    });
    const config = await validateZaloConfig(runtime);
    expect(config).not.toBeNull();
    expect(config!.ZALO_APP_ID).toBe("app");
  });

  it("returns null when required settings missing", async () => {
    const runtime = makeRuntime({});
    const config = await validateZaloConfig(runtime);
    expect(config).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. buildZaloSettings
// ══════════════════════════════════════════════════════════════════

describe("buildZaloSettings", () => {
  const baseConfig: ZaloConfig = {
    ZALO_APP_ID: "app123",
    ZALO_SECRET_KEY: "secret456",
    ZALO_ACCESS_TOKEN: "token789",
    ZALO_USE_POLLING: false,
    ZALO_ENABLED: true,
  };

  it("maps required fields correctly", () => {
    const s = buildZaloSettings(baseConfig);
    expect(s.appId).toBe("app123");
    expect(s.secretKey).toBe("secret456");
    expect(s.accessToken).toBe("token789");
  });

  it("defaults to webhook mode when ZALO_USE_POLLING is false", () => {
    const s = buildZaloSettings(baseConfig);
    expect(s.updateMode).toBe("webhook");
  });

  it("sets polling mode when ZALO_USE_POLLING is true", () => {
    const s = buildZaloSettings({ ...baseConfig, ZALO_USE_POLLING: true });
    expect(s.updateMode).toBe("polling");
  });

  it("applies default webhook path when not provided", () => {
    const s = buildZaloSettings(baseConfig);
    expect(s.webhookPath).toBe(DEFAULT_WEBHOOK_PATH);
  });

  it("applies default webhook port when not provided", () => {
    const s = buildZaloSettings(baseConfig);
    expect(s.webhookPort).toBe(DEFAULT_WEBHOOK_PORT);
  });

  it("uses custom webhook path when provided", () => {
    const s = buildZaloSettings({
      ...baseConfig,
      ZALO_WEBHOOK_PATH: "/custom/hook",
    });
    expect(s.webhookPath).toBe("/custom/hook");
  });

  it("uses custom webhook port when provided", () => {
    const s = buildZaloSettings({ ...baseConfig, ZALO_WEBHOOK_PORT: 9000 });
    expect(s.webhookPort).toBe(9000);
  });

  it("carries through optional refresh token", () => {
    const s = buildZaloSettings({
      ...baseConfig,
      ZALO_REFRESH_TOKEN: "refresh-tok",
    });
    expect(s.refreshToken).toBe("refresh-tok");
  });

  it("carries through optional proxy URL", () => {
    const s = buildZaloSettings({
      ...baseConfig,
      ZALO_PROXY_URL: "http://proxy:8080",
    });
    expect(s.proxyUrl).toBe("http://proxy:8080");
  });
});

// ══════════════════════════════════════════════════════════════════
// 6. sendMessageAction
// ══════════════════════════════════════════════════════════════════

describe("sendMessageAction", () => {
  it("has the correct name", () => {
    expect(sendMessageAction.name).toBe("SEND_ZALO_MESSAGE");
  });

  it("SEND_MESSAGE_ACTION constant matches action name", () => {
    expect(SEND_MESSAGE_ACTION).toBe(sendMessageAction.name);
  });

  it("has similes array with at least one entry", () => {
    expect(sendMessageAction.similes).toBeDefined();
    expect(sendMessageAction.similes!.length).toBeGreaterThanOrEqual(1);
  });

  it("has a description", () => {
    expect(sendMessageAction.description).toBeTruthy();
  });

  it("has examples", () => {
    expect(sendMessageAction.examples).toBeDefined();
    expect(sendMessageAction.examples!.length).toBeGreaterThanOrEqual(1);
  });

  describe("validate()", () => {
    const makeMessage = (source: string | undefined) =>
      ({ content: { source } }) as any;

    it("returns true when source is 'zalo'", async () => {
      const result = await sendMessageAction.validate(
        {} as any,
        makeMessage("zalo"),
      );
      expect(result).toBe(true);
    });

    it("returns false when source is 'telegram'", async () => {
      const result = await sendMessageAction.validate(
        {} as any,
        makeMessage("telegram"),
      );
      expect(result).toBe(false);
    });

    it("returns false when source is undefined", async () => {
      const result = await sendMessageAction.validate(
        {} as any,
        makeMessage(undefined),
      );
      expect(result).toBe(false);
    });

    it("returns false when source is empty string", async () => {
      const result = await sendMessageAction.validate(
        {} as any,
        makeMessage(""),
      );
      expect(result).toBe(false);
    });
  });

  describe("handler() error paths", () => {
    it("returns error when service is not available", async () => {
      const runtime = {
        getService: () => undefined,
      } as any;
      const message = { content: { source: "zalo" } } as any;
      const callback = vi.fn();

      const result = await sendMessageAction.handler(
        runtime,
        message,
        undefined,
        undefined,
        callback,
      );

      expect(result).toEqual({
        success: false,
        error: "Zalo service not initialized",
      });
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Zalo service not available" }),
      );
    });

    it("returns error when userId is missing", async () => {
      const runtime = {
        getService: () => ({
          sendTextMessage: vi.fn(),
        }),
      } as any;
      const message = { content: { source: "zalo" } } as any;
      const state = { values: { response: "Hello" } };
      const callback = vi.fn();

      const result = await sendMessageAction.handler(
        runtime,
        message,
        state as any,
        undefined,
        callback,
      );

      expect(result).toEqual({
        success: false,
        error: "Missing user ID",
      });
    });

    it("returns success when message is sent", async () => {
      const runtime = {
        getService: () => ({
          sendTextMessage: vi.fn().mockResolvedValue("msg-123"),
        }),
      } as any;
      const message = {
        content: { source: "zalo", userId: "user-1" },
      } as any;
      const state = { values: { response: "Hello Zalo" } };
      const callback = vi.fn();

      const result = await sendMessageAction.handler(
        runtime,
        message,
        state as any,
        undefined,
        callback,
      );

      expect(result).toEqual({
        success: true,
        data: expect.objectContaining({
          action: SEND_MESSAGE_ACTION,
          userId: "user-1",
          messageId: "msg-123",
        }),
      });
    });

    it("returns error when sendTextMessage throws", async () => {
      const runtime = {
        getService: () => ({
          sendTextMessage: vi.fn().mockRejectedValue(new Error("Network down")),
        }),
      } as any;
      const message = {
        content: { source: "zalo", userId: "user-1" },
      } as any;
      const state = { values: { response: "Hello" } };
      const callback = vi.fn();

      const result = await sendMessageAction.handler(
        runtime,
        message,
        state as any,
        undefined,
        callback,
      );

      expect(result).toEqual({
        success: false,
        error: "Network down",
      });
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Failed to send message"),
        }),
      );
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// 7. chatStateProvider
// ══════════════════════════════════════════════════════════════════

describe("chatStateProvider", () => {
  it("has the correct name", () => {
    expect(chatStateProvider.name).toBe("zalo_chat_state");
  });

  it("CHAT_STATE_PROVIDER constant matches provider name", () => {
    expect(CHAT_STATE_PROVIDER).toBe(chatStateProvider.name);
  });

  it("has a description", () => {
    expect(chatStateProvider.description).toBeTruthy();
  });

  it("is marked as dynamic", () => {
    expect(chatStateProvider.dynamic).toBe(true);
  });

  describe("get()", () => {
    it("returns platform 'zalo' in data", async () => {
      const message = { content: {}, roomId: "room-1" } as any;
      const result = await chatStateProvider.get({} as any, message, {} as any);
      expect(result.data.platform).toBe("zalo");
    });

    it("returns user_id from message content", async () => {
      const message = {
        content: { userId: "u-42" },
        roomId: "room-1",
      } as any;
      const result = await chatStateProvider.get({} as any, message, {} as any);
      expect(result.data.userId).toBe("u-42");
      expect(result.values.user_id).toBe("u-42");
    });

    it("sets chatId to userId when chatId absent", async () => {
      const message = {
        content: { userId: "u-99" },
        roomId: "room-2",
      } as any;
      const result = await chatStateProvider.get({} as any, message, {} as any);
      expect(result.data.chatId).toBe("u-99");
    });

    it("always reports isPrivate = true (OA only supports DMs)", async () => {
      const message = { content: {}, roomId: "room-3" } as any;
      const result = await chatStateProvider.get({} as any, message, {} as any);
      expect(result.data.isPrivate).toBe(true);
    });

    it("includes human-readable text", async () => {
      const message = {
        content: { userId: "u-1" },
        roomId: "r-1",
      } as any;
      const result = await chatStateProvider.get({} as any, message, {} as any);
      expect(result.text).toContain("Zalo Chat State");
      expect(result.text).toContain("u-1");
    });

    it("returns empty strings for missing optional values", async () => {
      const message = { content: {}, roomId: undefined } as any;
      const result = await chatStateProvider.get({} as any, message, {} as any);
      expect(result.values.user_id).toBe("");
      expect(result.values.room_id).toBe("");
    });
  });
});
