import { describe, expect, it, mock } from "bun:test";
import { requireLoginValue } from "../../../../required";

import { EmailAuth } from "../email";
import type { EmailProvider } from "../email-provider";
import type { StoreBackend, StorePublishEntry } from "../store-backends";
import { TokenStore } from "../token-store";

class CapturingBackend implements StoreBackend {
  values = new Map<string, { value: string; expiresAt: number }>();

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async setIfNotExists(
    key: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean> {
    if (await this.get(key)) return false;
    await this.set(key, value, ttlMs);
    return true;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  async consume(key: string): Promise<string | null> {
    const value = await this.get(key);
    this.values.delete(key);
    return value;
  }

  async compareDelete(key: string, expected: string): Promise<boolean> {
    if ((await this.get(key)) !== expected) return false;
    this.values.delete(key);
    return true;
  }

  async transition(
    key: string,
    expected: string,
    desired: string,
    ttlMs: number,
  ): Promise<boolean> {
    const current = await this.get(key);
    if (current !== expected && current !== desired) return false;
    await this.set(key, desired, ttlMs);
    return true;
  }

  async publish(entries: readonly StorePublishEntry[]): Promise<boolean> {
    const now = Date.now();
    const guarded = entries.filter((entry) => entry.expected !== undefined);
    const states = guarded.map((entry) => {
      const existing = this.values.get(entry.key);
      const current =
        existing && now <= existing.expiresAt ? existing.value : null;
      return {
        expected: current === entry.expected,
        desired: current === entry.value,
      };
    });
    if (states.length > 0 && states.every((state) => state.desired))
      return true;
    if (states.some((state) => !state.expected)) return false;
    for (const entry of entries) {
      if (entry.value === null) this.values.delete(entry.key);
      else
        this.values.set(entry.key, {
          value: entry.value,
          expiresAt: entry.expiresAt,
        });
    }
    return true;
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

describe("EmailAuth.sendMagicLink", () => {
  it("calls the template renderer with the agreed magic-link payload", async () => {
    const sent = mock(async () => ({ provider: "test" }));
    const templateRenderer = mock(() => ({
      subject: "subject",
      text: "text",
      html: "<p>html</p>",
    }));
    const provider: EmailProvider = { send: sent };
    const auth = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider,
      templateId: "customer-template",
      tokenTtlMs: 10 * 60 * 1000,
      templateRenderer,
    });

    await auth.sendMagicLink("user@example.com");

    expect(templateRenderer).toHaveBeenCalledTimes(1);
    const [templateId, data] = requireLoginValue(
      templateRenderer.mock.calls[0],
      "templateRenderer.mock.calls[0]",
    );
    expect(templateId).toBe("customer-template");
    expect(data).toMatchObject({
      email: "user@example.com",
      code: expect.stringMatching(/^\d{6}$/),
      expiresInMinutes: 10,
      tenantName: undefined,
    });
    expect(data.magicLink).toContain("https://steward.fi/auth/callback/email?");
    expect(data.magicLink).toContain("email=user%40example.com");

    expect(sent).toHaveBeenCalledTimes(1);

    auth.destroy();
  });

  it("passes the configured brand to magic-link and OTP renderers", async () => {
    const sent = mock(async () => ({ provider: "test" }));
    const templateRenderer = mock(() => ({
      subject: "magic subject",
      text: "magic text",
      html: "<p>magic html</p>",
    }));
    const otpTemplateRenderer = mock(() => ({
      subject: "otp subject",
      text: "otp text",
      html: "<p>otp html</p>",
    }));
    const auth = new EmailAuth({
      from: "login@example.test",
      baseUrl: "https://app.example.test",
      callbackPath: "/auth/callback/email",
      brandName: "Customer Cloud",
      provider: { send: sent },
      templateRenderer,
      otpTemplateRenderer,
    });

    await auth.sendMagicLink("user@example.test", { tenantId: "customer" });
    await auth.sendOtp("user@example.test", { tenantId: "customer" });

    const [, magicData] = requireLoginValue(
      templateRenderer.mock.calls[0],
      "templateRenderer.mock.calls[0]",
    );
    const [, otpData] = requireLoginValue(
      otpTemplateRenderer.mock.calls[0],
      "otpTemplateRenderer.mock.calls[0]",
    );
    expect(magicData).toMatchObject({
      tenantName: "Customer Cloud",
    });
    expect(magicData.magicLink).toContain(
      "https://app.example.test/auth/callback/email?",
    );
    expect(otpData).toMatchObject({
      brandName: "Customer Cloud",
    });

    auth.destroy();
  });

  it("binds the tenant into the magic link for non-default tenants (and omits it otherwise)", async () => {
    const sent = mock(async () => ({ provider: "test" }));
    const templateRenderer = mock(() => ({
      subject: "subject",
      text: "text",
      html: "<p>html</p>",
    }));
    const provider: EmailProvider = { send: sent };
    const auth = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider,
      templateId: "customer-template",
      tokenTtlMs: 10 * 60 * 1000,
      templateRenderer,
    });

    // Non-default tenant: the emailed link must carry ?tenantId so
    // GET /auth/callback/email resolves the SAME tenant the token was minted
    // for (otherwise the verify guard fires tenant_mismatch and the exchange
    // code is stored under the wrong tenant).
    await auth.sendMagicLink("user@example.com", { tenantId: "customer" });
    const [, withTenant] = requireLoginValue(
      templateRenderer.mock.calls[0],
      "templateRenderer.mock.calls[0]",
    );
    expect(withTenant.magicLink).toContain("tenantId=customer");

    // No tenant context: byte-for-byte back-compat — no tenantId param at all.
    await auth.sendMagicLink("user@example.com");
    const [, withoutTenant] = requireLoginValue(
      templateRenderer.mock.calls[1],
      "templateRenderer.mock.calls[1]",
    );
    expect(withoutTenant.magicLink).not.toContain("tenantId");

    auth.destroy();
  });

  it("sends tenant invitation emails with a one-time accept link", async () => {
    const sent = mock(async () => ({ provider: "test" }));
    const provider: EmailProvider = { send: sent };
    const auth = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider,
    });

    await auth.sendTenantInvitation("user@example.com", {
      tenantId: "tenant-1",
      tenantName: "Tenant One",
      token: "a".repeat(64),
      expiresAt: new Date("2026-06-01T12:00:00.000Z"),
    });

    expect(sent).toHaveBeenCalledTimes(1);
    const [to, subject, text, html] = requireLoginValue(
      sent.mock.calls[0],
      "sent.mock.calls[0]",
    );
    expect(to).toBe("user@example.com");
    expect(subject).toBe("You're invited to Tenant One on elizaOS");
    expect(text).toContain("https://steward.fi/accept-invitation?");
    expect(text).toContain("tenantId=tenant-1");
    expect(text).toContain(`token=${"a".repeat(64)}`);
    expect(html).toContain("Accept invitation");

    auth.destroy();
  });

  it("sends one message with a shared link and six-digit sign-in code", async () => {
    const sent = mock(async () => ({ provider: "test" }));
    const provider: EmailProvider = { send: sent };
    const auth = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider,
    });

    const result = await auth.sendMagicLink("user@example.com", {
      tenantId: "tenant-a",
    });

    expect(result.challengeId).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(result.pollSecret).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(sent).toHaveBeenCalledTimes(1);
    const [, , text, html] = requireLoginValue(
      sent.mock.calls[0],
      "sent.mock.calls[0]",
    );
    expect(text).toContain("https://steward.fi/auth/callback/email?");
    expect(text).toMatch(/\b\d{6}\b/);
    expect(html).toMatch(/\b\d{6}\b/);

    auth.destroy();
  });

  it("lets either link or code redeem the shared challenge exactly once", async () => {
    let text = "";
    const auth = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider: {
        send: async (_to, _subject, body) => (
          (text = body), { provider: "test" }
        ),
      },
    });

    await auth.sendMagicLink("user@example.com", { tenantId: "tenant-a" });
    const token = text.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    const code = text.match(/\b(\d{6})\b/)?.[1] ?? "";
    const link = await auth.verifyMagicLink(
      token,
      "user@example.com",
      "tenant-a",
    );
    expect(link.valid).toBe(true);
    const codeAfterLink = await auth.verifyEmailLoginCode(
      "user@example.com",
      code,
      "tenant-a",
    );
    expect(codeAfterLink.valid).toBe(false);

    await auth.sendMagicLink("user@example.com", { tenantId: "tenant-a" });
    const token2 = text.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    const code2 = text.match(/\b(\d{6})\b/)?.[1] ?? "";
    const codeFirst = await auth.verifyEmailLoginCode(
      "user@example.com",
      code2,
      "tenant-a",
    );
    expect(codeFirst.valid).toBe(true);
    const linkAfterCode = await auth.verifyMagicLink(
      token2,
      "user@example.com",
      "tenant-a",
    );
    expect(linkAfterCode.valid).toBe(false);

    auth.destroy();
  });

  it("hard locks the active challenge after five wrong code attempts", async () => {
    let text = "";
    const auth = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider: {
        send: async (_to, _subject, body) => (
          (text = body), { provider: "test" }
        ),
      },
    });
    await auth.sendMagicLink("lock@example.com", { tenantId: "tenant-a" });
    const code = text.match(/\b(\d{6})\b/)?.[1] ?? "";
    const wrongCode = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i++) {
      const result = await auth.verifyEmailLoginCode(
        "lock@example.com",
        wrongCode,
        "tenant-a",
      );
      expect(result.valid).toBe(false);
    }
    const afterLock = await auth.verifyEmailLoginCode(
      "lock@example.com",
      code,
      "tenant-a",
    );
    expect(afterLock.valid).toBe(false);

    auth.destroy();
  });

  it("reports consumed through polling after either credential redeems", async () => {
    let text = "";
    const auth = new EmailAuth({
      from: "login.fi",
      baseUrl: "https://steward.fi",
      provider: {
        send: async (_to, _subject, body) => (
          (text = body), { provider: "test" }
        ),
      },
    });
    const issued = await auth.sendMagicLink("poll.com", {
      tenantId: "tenant-a",
    });
    const token = text.match(/[?&]token=([a-f0-9]{64})/i)?.[1] ?? "";
    expect(
      await auth.getEmailLoginStatus(issued.challengeId, issued.pollSecret),
    ).toMatchObject({
      status: "pending",
    });
    await auth.verifyMagicLink(token, "poll.com", "tenant-a");
    expect(
      await auth.getEmailLoginStatus(issued.challengeId, issued.pollSecret),
    ).toEqual({
      status: "consumed",
    });
    expect(
      await auth.getEmailLoginStatus(issued.challengeId, "wrong-secret"),
    ).toEqual({
      status: "invalid",
    });
    auth.destroy();
  });

  it("does not persist raw magic-link token, code, or poll secret in pending challenge records", async () => {
    const backend = new CapturingBackend();
    let text = "";
    const auth = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider: {
        send: async (_to, _subject, body) => (
          (text = body), { provider: "test" }
        ),
      },
      tokenStore: new TokenStore({ backend }),
      codeVerifierSecret: "test-secret",
    });
    const issued = await auth.sendMagicLink("secret@example.com", {
      tenantId: "tenant-a",
    });
    const token = text.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    const code = text.match(/\b(\d{6})\b/)?.[1] ?? "";
    const persisted = [...backend.values.values()]
      .map((entry) => entry.value)
      .join("\n");

    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain(code);
    expect(persisted).not.toContain(issued.pollSecret);

    auth.destroy();
  });
});

describe("EmailAuth.sendOtp", () => {
  it("routes OTP emails through the per-tenant otp template renderer", async () => {
    const sent = mock(async () => ({ provider: "test" }));
    const otpTemplateRenderer = mock(() => ({
      subject: "otp subject",
      text: "otp text",
      html: "<p>otp html</p>",
    }));
    const provider: EmailProvider = { send: sent };
    const auth = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider,
      templateId: "customer-template",
      tokenTtlMs: 10 * 60 * 1000,
      otpTemplateRenderer,
    });

    await auth.sendOtp("user@example.com", {
      tenantId: "customer",
      tenantName: "Customer App",
    });

    expect(otpTemplateRenderer).toHaveBeenCalledTimes(1);
    const [templateId, data] = requireLoginValue(
      otpTemplateRenderer.mock.calls[0],
      "otpTemplateRenderer.mock.calls[0]",
    );
    expect(templateId).toBe("customer-template");
    expect(data).toMatchObject({
      email: "user@example.com",
      brandName: "Customer App",
      expiresInMinutes: 10,
    });
    expect(data.code).toMatch(/^\d{6}$/);

    expect(sent).toHaveBeenCalledTimes(1);
    const [to, subject, text, html] = requireLoginValue(
      sent.mock.calls[0],
      "sent.mock.calls[0]",
    );
    expect(to).toBe("user@example.com");
    expect(subject).toBe("otp subject");
    expect(text).toBe("otp text");
    expect(html).toBe("<p>otp html</p>");

    auth.destroy();
  });

  it("renders the elizaOS default OTP email when no template is configured", async () => {
    const sent = mock(async () => ({ provider: "test" }));
    const provider: EmailProvider = { send: sent };
    const auth = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider,
      tokenTtlMs: 10 * 60 * 1000,
    });

    await auth.sendOtp("user@example.com", { tenantName: "Acme" });

    const [, subject, text, html] = requireLoginValue(
      sent.mock.calls[0],
      "sent.mock.calls[0]",
    );
    expect(subject).toMatch(/^\d{6} is your Acme sign-in code$/);
    expect(text).toContain("Your Acme sign-in code is:");
    expect(html).toContain("Acme sign-in code");
    expect(html).toContain("#0b0a09");

    auth.destroy();
  });
});
