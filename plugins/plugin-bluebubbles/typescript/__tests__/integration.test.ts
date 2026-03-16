import { describe, expect, it, vi } from "vitest";

import blueBubblesPlugin, {
  BLUEBUBBLES_SERVICE_NAME,
  BlueBubblesService,
  chatContextProvider,
  sendMessageAction,
  sendReactionAction,
} from "../src/index";

import {
  normalizeHandle,
  isHandleAllowed,
  validateConfig,
} from "../src/environment";

import {
  DEFAULT_WEBHOOK_PATH,
  API_ENDPOINTS,
  DM_POLICY_OPEN,
  DM_POLICY_DISABLED,
  DM_POLICY_PAIRING,
  DM_POLICY_ALLOWLIST,
  GROUP_POLICY_OPEN,
  GROUP_POLICY_ALLOWLIST,
  GROUP_POLICY_DISABLED,
} from "../src/constants";

// ----------------------------------------------------------------
// Plugin exports
// ----------------------------------------------------------------

describe("BlueBubbles plugin exports", () => {
  it("exports plugin metadata", () => {
    expect(blueBubblesPlugin.name).toBe(BLUEBUBBLES_SERVICE_NAME);
    expect(blueBubblesPlugin.description).toContain("BlueBubbles");
    expect(Array.isArray(blueBubblesPlugin.actions)).toBe(true);
    expect(Array.isArray(blueBubblesPlugin.providers)).toBe(true);
    expect(Array.isArray(blueBubblesPlugin.services)).toBe(true);
  });

  it("exports actions, providers, and service", () => {
    expect(sendMessageAction).toBeDefined();
    expect(sendReactionAction).toBeDefined();
    expect(chatContextProvider).toBeDefined();
    expect(BlueBubblesService).toBeDefined();
  });

  it("registers exactly 2 actions", () => {
    expect(blueBubblesPlugin.actions).toHaveLength(2);
  });

  it("registers exactly 1 provider", () => {
    expect(blueBubblesPlugin.providers).toHaveLength(1);
  });
});

// ----------------------------------------------------------------
// normalizeHandle
// ----------------------------------------------------------------

describe("normalizeHandle", () => {
  it("normalizes a formatted US phone number", () => {
    expect(normalizeHandle("+1 (555) 123-4567")).toBe("+15551234567");
  });

  it("normalizes a phone number without plus prefix", () => {
    expect(normalizeHandle("555-123-4567")).toBe("+5551234567");
  });

  it("normalizes an international phone number", () => {
    expect(normalizeHandle("+44 7700 900000")).toBe("+447700900000");
  });

  it("lowercases an email address", () => {
    expect(normalizeHandle("User@Example.COM")).toBe("user@example.com");
  });

  it("trims whitespace from an email", () => {
    expect(normalizeHandle("  test@test.com  ")).toBe("test@test.com");
  });

  it("handles short digit strings without adding plus", () => {
    expect(normalizeHandle("12345")).toBe("12345");
  });

  it("handles a phone number with dots", () => {
    expect(normalizeHandle("+1.555.123.4567")).toBe("+15551234567");
  });
});

// ----------------------------------------------------------------
// isHandleAllowed
// ----------------------------------------------------------------

describe("isHandleAllowed", () => {
  it("open policy allows any handle", () => {
    expect(isHandleAllowed("anyone@example.com", [], DM_POLICY_OPEN)).toBe(true);
  });

  it("disabled policy denies all handles", () => {
    expect(isHandleAllowed("anyone@example.com", [], DM_POLICY_DISABLED)).toBe(false);
  });

  it("pairing with empty allowlist allows first contact", () => {
    expect(isHandleAllowed("first@contact.com", [], DM_POLICY_PAIRING)).toBe(true);
  });

  it("pairing with non-empty allowlist only allows listed handles", () => {
    expect(isHandleAllowed("+15551234567", ["+15551234567"], DM_POLICY_PAIRING)).toBe(true);
    expect(isHandleAllowed("+15559999999", ["+15551234567"], DM_POLICY_PAIRING)).toBe(false);
  });

  it("allowlist matches normalized handles", () => {
    const allowList = ["+15551234567"];
    expect(isHandleAllowed("+1 (555) 123-4567", allowList, DM_POLICY_ALLOWLIST)).toBe(true);
  });

  it("allowlist rejects non-matching handles", () => {
    const allowList = ["+15551234567"];
    expect(isHandleAllowed("+15559876543", allowList, DM_POLICY_ALLOWLIST)).toBe(false);
  });

  it("group open policy allows all", () => {
    expect(isHandleAllowed("anyone", [], GROUP_POLICY_OPEN)).toBe(true);
  });

  it("group disabled policy denies all", () => {
    expect(isHandleAllowed("anyone", [], GROUP_POLICY_DISABLED)).toBe(false);
  });

  it("group allowlist matches normalized handles", () => {
    expect(isHandleAllowed("+1 555 123 4567", ["+15551234567"], GROUP_POLICY_ALLOWLIST)).toBe(true);
  });
});

// ----------------------------------------------------------------
// validateConfig
// ----------------------------------------------------------------

describe("validateConfig", () => {
  it("accepts a valid config", () => {
    const config = validateConfig({
      serverUrl: "http://localhost:1234",
      password: "secret",
    });
    expect(config.serverUrl).toBe("http://localhost:1234");
    expect(config.password).toBe("secret");
    expect(config.webhookPath).toBe(DEFAULT_WEBHOOK_PATH);
    expect(config.dmPolicy).toBe("pairing");
    expect(config.groupPolicy).toBe("allowlist");
    expect(config.sendReadReceipts).toBe(true);
    expect(config.enabled).toBe(true);
  });

  it("rejects missing server URL", () => {
    expect(() =>
      validateConfig({ serverUrl: "", password: "secret" })
    ).toThrow();
  });

  it("rejects missing password", () => {
    expect(() =>
      validateConfig({ serverUrl: "http://localhost:1234", password: "" })
    ).toThrow();
  });

  it("rejects an invalid URL", () => {
    expect(() =>
      validateConfig({ serverUrl: "not-a-url", password: "secret" })
    ).toThrow();
  });

  it("preserves custom webhook path", () => {
    const config = validateConfig({
      serverUrl: "http://localhost:1234",
      password: "secret",
      webhookPath: "/custom/webhook",
    });
    expect(config.webhookPath).toBe("/custom/webhook");
  });
});

// ----------------------------------------------------------------
// Action definitions
// ----------------------------------------------------------------

describe("sendMessageAction", () => {
  it("has the correct name", () => {
    expect(sendMessageAction.name).toBe("SEND_BLUEBUBBLES_MESSAGE");
  });

  it("has a non-empty description", () => {
    expect(sendMessageAction.description).toBeTruthy();
    expect(sendMessageAction.description!.length).toBeGreaterThan(10);
  });

  it("has similes", () => {
    expect(Array.isArray(sendMessageAction.similes)).toBe(true);
    expect(sendMessageAction.similes!.length).toBeGreaterThan(0);
  });

  it("has at least one example", () => {
    expect(Array.isArray(sendMessageAction.examples)).toBe(true);
    expect(sendMessageAction.examples!.length).toBeGreaterThan(0);
  });

  it("validate rejects when service is missing", async () => {
    const mockRuntime = {
      getService: vi.fn().mockReturnValue(null),
    } as any;
    const mockMessage = { content: { source: "bluebubbles" } } as any;
    const result = await sendMessageAction.validate!(mockRuntime, mockMessage);
    expect(result).toBe(false);
  });
});

describe("sendReactionAction", () => {
  it("has the correct name", () => {
    expect(sendReactionAction.name).toBe("BLUEBUBBLES_SEND_REACTION");
  });

  it("has a non-empty description", () => {
    expect(sendReactionAction.description).toBeTruthy();
  });

  it("has similes including BLUEBUBBLES_REACT", () => {
    expect(sendReactionAction.similes).toContain("BLUEBUBBLES_REACT");
  });

  it("validate rejects non-bluebubbles sources", async () => {
    const mockRuntime = {} as any;
    const mockMessage = { content: { source: "discord" } } as any;
    const result = await sendReactionAction.validate!(mockRuntime, mockMessage);
    expect(result).toBe(false);
  });

  it("validate accepts bluebubbles source", async () => {
    const mockRuntime = {} as any;
    const mockMessage = { content: { source: "bluebubbles" } } as any;
    const result = await sendReactionAction.validate!(mockRuntime, mockMessage);
    expect(result).toBe(true);
  });
});

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

describe("constants", () => {
  it("has expected API endpoints", () => {
    expect(API_ENDPOINTS.SEND_MESSAGE).toBeDefined();
    expect(API_ENDPOINTS.REACT).toBeDefined();
    expect(API_ENDPOINTS.SERVER_INFO).toBeDefined();
  });

  it("service name is bluebubbles", () => {
    expect(BLUEBUBBLES_SERVICE_NAME).toBe("bluebubbles");
  });
});
