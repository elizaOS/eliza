import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  normalizeEmail,
  parseEmailAddress,
  resolveSendGridConfig,
  sendViaSendGrid,
} from "../services/email-utils";

mock.module("@feed/shared", () => ({
  getAllVerifiedEmails: mock(() => []),
  logger: {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  },
}));

mock.module("../auth-middleware", () => ({
  // Phase 2: Privy removed; getPrivyClient no longer used
}));

describe("parseEmailAddress", () => {
  it("parses a plain email address", () => {
    expect(parseEmailAddress("user@example.com")).toEqual({
      email: "user@example.com",
    });
  });

  it("lowercases a plain email", () => {
    expect(parseEmailAddress("User@Example.COM")).toEqual({
      email: "user@example.com",
    });
  });

  it("trims whitespace", () => {
    expect(parseEmailAddress("  user@example.com  ")).toEqual({
      email: "user@example.com",
    });
  });

  it("parses a named email address", () => {
    expect(parseEmailAddress("Feed Team <team@feed.market>")).toEqual({
      email: "team@feed.market",
      name: "Feed Team",
    });
  });

  it("strips surrounding quotes from name", () => {
    expect(parseEmailAddress('"Feed Team" <team@feed.market>')).toEqual({
      email: "team@feed.market",
      name: "Feed Team",
    });
  });

  it("returns null for empty string", () => {
    expect(parseEmailAddress("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseEmailAddress("   ")).toBeNull();
  });

  it("returns null for invalid format", () => {
    expect(parseEmailAddress("not-an-email")).toBeNull();
  });

  it("returns null for missing domain", () => {
    expect(parseEmailAddress("user@")).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("returns null for null input", () => {
    expect(normalizeEmail(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(normalizeEmail(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeEmail("")).toBeNull();
  });

  it("normalizes a valid email", () => {
    expect(normalizeEmail("User@Example.COM")).toBe("user@example.com");
  });

  it("trims whitespace", () => {
    expect(normalizeEmail("  user@example.com  ")).toBe("user@example.com");
  });

  it("returns null for invalid email format", () => {
    expect(normalizeEmail("not-an-email")).toBeNull();
  });
});

describe("resolveSendGridConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when SENDGRID_API_KEY is missing", () => {
    delete process.env.SENDGRID_API_KEY;
    expect(resolveSendGridConfig("Test")).toBeNull();
  });

  it("returns null when SENDGRID_API_KEY is empty/whitespace", () => {
    process.env.SENDGRID_API_KEY = "   ";
    expect(resolveSendGridConfig("Test")).toBeNull();
  });

  it("returns null when no from address is configured", () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    delete process.env.NOTIFICATION_EMAIL_FROM;
    delete process.env.EMAIL_FROM;
    expect(resolveSendGridConfig("Test")).toBeNull();
  });

  it("returns null when from address is invalid", () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    process.env.NOTIFICATION_EMAIL_FROM = "not-an-email";
    expect(resolveSendGridConfig("Test")).toBeNull();
  });

  it("resolves config with NOTIFICATION_EMAIL_FROM", () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    process.env.NOTIFICATION_EMAIL_FROM = "noreply@feed.market";

    const config = resolveSendGridConfig("Test");
    expect(config).toEqual({
      apiKey: "SG.test-key",
      from: { email: "noreply@feed.market" },
    });
  });

  it("falls back to EMAIL_FROM when NOTIFICATION_EMAIL_FROM is missing", () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    delete process.env.NOTIFICATION_EMAIL_FROM;
    process.env.EMAIL_FROM = "fallback@feed.market";

    const config = resolveSendGridConfig("Test");
    expect(config).toEqual({
      apiKey: "SG.test-key",
      from: { email: "fallback@feed.market" },
    });
  });

  it("resolves named from address", () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    process.env.NOTIFICATION_EMAIL_FROM = "Feed Team <team@feed.market>";

    const config = resolveSendGridConfig("Test");
    expect(config).toEqual({
      apiKey: "SG.test-key",
      from: { email: "team@feed.market", name: "Feed Team" },
    });
  });
});

describe("sendViaSendGrid", () => {
  const testPayload = {
    from: { email: "test@example.com" },
    personalizations: [{ to: [{ email: "user@example.com" }] }],
    subject: "Test",
    content: [{ type: "text/plain", value: "Hello" }],
  };

  it("returns sent: true on 202 response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 202 })),
    ) as unknown as typeof fetch;

    try {
      const result = await sendViaSendGrid("key", testPayload, "Test");
      expect(result).toEqual({ sent: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns provider_error on non-ok response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Bad Request", { status: 400 })),
    ) as unknown as typeof fetch;

    try {
      const result = await sendViaSendGrid("key", testPayload, "Test");
      expect(result.sent).toBe(false);
      expect(result.reason).toBe("provider_error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns network_error when fetch throws", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Network failure")),
    ) as unknown as typeof fetch;

    try {
      const result = await sendViaSendGrid("key", testPayload, "Test");
      expect(result.sent).toBe(false);
      expect(result.reason).toBe("network_error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends correct authorization header and payload", async () => {
    const originalFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(new Response(null, { status: 202 }));
    }) as unknown as typeof fetch;

    try {
      await sendViaSendGrid("SG.my-key", testPayload, "Test");
      expect(capturedInit?.headers).toEqual({
        Authorization: "Bearer SG.my-key",
        "Content-Type": "application/json",
      });
      const body = JSON.parse(capturedInit?.body as string);
      expect(body.from.email).toBe("test@example.com");
      expect(body.subject).toBe("Test");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
