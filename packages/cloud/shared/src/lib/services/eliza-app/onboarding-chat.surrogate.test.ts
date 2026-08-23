/**
 * Focused regression for #24971: memory-copy error body surfaced via the real
 * exported onboarding path must be bounded, well-formed, and preserve HTTP status.
 * Covers astral emoji straddling 200 code units and lone-surrogate handling.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realCloudBindings from "../../runtime/cloud-bindings";

const sessionCache = new Map<string, unknown>();
const getElizaAppProvisioningStatus = mock();
const readManagedElizaAgentConnection = mock();
const loggerWarn = mock();
let cloudEnv: Record<string, string | undefined> = {};
const REAL_CLOUD_BINDINGS = { ...realCloudBindings };

mock.module("../../cache/client", () => ({
  CacheClient: class CacheClient {
    private values = new Map<string, unknown>();
    isAvailable() { return true; }
    async get(key: string) { return this.values.get(key) ?? null; }
    async set(key: string, value: unknown) { this.values.set(key, value); }
    async expire() {}
    async del(key: string) { this.values.delete(key); }
  },
  cache: {
    get: mock(async (key: string) => sessionCache.get(key) ?? null),
    set: mock(async (key: string, value: unknown) => { sessionCache.set(key, value); }),
  },
}));

mock.module("../../runtime/cloud-bindings", () => ({
  ...REAL_CLOUD_BINDINGS,
  getCloudAwareEnv: mock(() => cloudEnv),
}));

mock.module("../../utils/logger", () => ({
  logger: { warn: loggerWarn, debug: mock(), info: mock(), error: mock() },
}));

mock.module("../eliza-managed-launch", () => ({
  readManagedElizaAgentConnection,
}));

mock.module("./provisioning", () => ({
  getElizaAppProvisioningStatus,
}));

mock.module("./user-service", () => ({
  elizaAppUserService: {
    findOrCreateByPhone: mock(async () => ({ user: { id: "user-1" }, organization: { id: "org-1" }, isNew: false })),
    linkPhoneToUser: mock(async () => ({ success: true })),
    linkDiscordToUser: mock(async () => ({ success: true })),
    linkTelegramToUser: mock(async () => ({ success: true })),
  },
}));

const { runOnboardingChat } = await import(`./onboarding-chat.ts?test=onboarding-surrogate-${Date.now()}`);

describe("onboarding-chat memory-copy surrogate-safe preview (#24971)", () => {
  beforeEach(() => {
    sessionCache.clear();
    getElizaAppProvisioningStatus.mockReset();
    readManagedElizaAgentConnection.mockReset();
    loggerWarn.mockReset();
    cloudEnv = {};
    getElizaAppProvisioningStatus.mockResolvedValue({
      status: "running",
      agentId: "agent-1",
      bridgeUrl: "https://agent-1.example",
      sandbox: { id: "agent-1", status: "running", bridge_url: "https://agent-1.example" },
    });
    readManagedElizaAgentConnection.mockResolvedValue({
      apiBase: "https://agent-1.example",
      token: "agent-token",
    });
  });

  afterEach(() => {
    loggerWarn.mockReset();
  });

  test("surfaces bounded well-formed preview without splitting astral at 200 and preserves 500", async () => {
    const astral = "🦊";
    const body = "a".repeat(199) + astral + "b".repeat(50);
    expect(body.length).toBe(199 + 2 + 50);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(body, { status: 500, statusText: "Internal Server Error" }),
    ) as unknown as typeof fetch;

    try {
      const result = await runOnboardingChat({
        message: "My name is Sam",
        platform: "blooio",
        platformUserId: "+14155550123",
        sessionId: "platform:blooio:+14155550123",
        trustedPlatformIdentity: true,
        authenticatedUser: { userId: "user-1", organizationId: "org-1" },
      });
      expect(result.handoffComplete).toBe(false);
      expect(result.session.handoffCopiedAt).toBeUndefined();
      const handoffWarn = loggerWarn.mock.calls.find((args: unknown[]) =>
        String(args[0]).includes("handoff memory copy failed"),
      ) as unknown[] | undefined;
      expect(handoffWarn).toBeTruthy();
      const errorField = (handoffWarn?.[1] as Record<string, unknown>)?.error as string;
      expect(errorField).toContain("memory copy failed (500)");
      const preview = errorField.split("memory copy failed (500) ")[1] ?? "";
      expect(preview.length).toBeLessThanOrEqual(200);
      expect(preview.includes("\uD800")).toBe(false);
      expect(preview.includes("\uDC00")).toBe(false);
      expect(errorField).toMatch(/\(500\)/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("replaces lone surrogate via toWellFormedUnicode before truncation", async () => {
    const lone = "\uD800";
    const body = lone + "x".repeat(250);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        headers: new Headers(),
        text: async () => body,
      }) as unknown as Response,
    ) as unknown as typeof fetch;

    try {
      const result = await runOnboardingChat({
        message: "My name is Sam",
        platform: "blooio",
        platformUserId: "+14155550123",
        sessionId: "platform:blooio:+14155550123-lone",
        trustedPlatformIdentity: true,
        authenticatedUser: { userId: "user-1", organizationId: "org-1" },
      });
      expect(result.handoffComplete).toBe(false);
      const handoffWarn = loggerWarn.mock.calls.find((args: unknown[]) =>
        String(args[0]).includes("handoff memory copy failed"),
      ) as unknown[] | undefined;
      const errorField = String((handoffWarn?.[1] as Record<string, unknown>)?.error ?? "");
      expect(errorField.includes("\uD800")).toBe(false);
      expect(errorField).toContain("�");
      const preview = errorField.split("memory copy failed (503) ")[1] ?? "";
      expect(preview.length).toBeLessThanOrEqual(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("translates body-read failure to [unreadable] without fabricating empty preview", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      ({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        headers: new Headers(),
        text: async () => { throw new Error("body stream broke"); },
      }) as unknown as Response,
    ) as unknown as typeof fetch;

    try {
      const result = await runOnboardingChat({
        message: "My name is Sam",
        platform: "blooio",
        platformUserId: "+14155550123",
        sessionId: "platform:blooio:+14155550123-readfail",
        trustedPlatformIdentity: true,
        authenticatedUser: { userId: "user-1", organizationId: "org-1" },
      });
      expect(result.handoffComplete).toBe(false);
      const calls = loggerWarn.mock.calls as unknown[][];
      const readWarn = calls.find((c) => String(c[0]).includes("failed to read remember error body"));
      expect(readWarn).toBeTruthy();
      const handoffWarn = calls.find((c) => String(c[0]).includes("handoff memory copy failed"));
      const errorField = String((handoffWarn?.[1] as Record<string, unknown>)?.error ?? "");
      expect(errorField).toContain("memory copy failed (502) [unreadable]");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
