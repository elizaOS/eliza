/**
 * Fail-closed email delivery (elizaOS/eliza#18452).
 *
 * A magic-link/OTP send may return success ONLY after the provider ACCEPTED
 * the message. Before this hardening a rejecting provider left the challenge
 * redeemable behind a 500, and a production deployment without a real
 * provider silently "delivered" via ConsoleProvider and returned ok:true —
 * a false green for a challenge no one could ever receive.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { requireLoginValue } from "../../../../required";

import { hashSha256Hex } from "../crypto";
import { EmailAuth } from "../email";
import {
  ConsoleProvider,
  EmailDeliveryError,
  EmailDeliveryNotConfiguredError,
  type EmailDeliveryReceipt,
  type EmailProvider,
  MockEmailInbox,
  MockEmailProvider,
  ResendProvider,
} from "../email-provider";
import {
  MemoryBackend,
  type StoreBackend,
  type StorePublishEntry,
} from "../store-backends";
import { TokenStore } from "../token-store";

const codeVerifierSecret = randomBytes(32).toString("hex");

class CapturingBackend implements StoreBackend {
  values = new Map<string, { value: string; expiresAt: number }>();
  failWrites = false;
  failActiveWrites = false;
  failActiveWritesAfterCommit = false;
  failReadsAfterActiveCommit = false;
  activeTransitionFailuresAfterCommit = 0;
  failFirstActivationPublishAfterMs = 0;
  delaySuccessfulActivationPublishMs = 0;
  activationPublishExpiresAt: number[] = [];
  afterActivationCommitBeforeLostAck?: () => Promise<void>;
  failDeletes = false;
  replaceGuardBeforeTransition = false;

  private isActivation(key: string, value: string | null): boolean {
    if (value === null) return false;
    if (
      value.includes('"status":"active"') ||
      (value.includes('"purpose":"email-login"') &&
        value.includes('"status":"pending"'))
    ) {
      return true;
    }
    if (key.length !== 64) return false;
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return (
        typeof parsed.email === "string" &&
        Object.keys(parsed).every(
          (field) => field === "email" || field === "tenantId",
        )
      );
    } catch {
      return false;
    }
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    if (this.failWrites) throw new Error("durable store unavailable");
    if (this.failActiveWrites && this.isActivation(key, value)) {
      throw new Error("durable activation unavailable");
    }
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (this.failActiveWritesAfterCommit && this.isActivation(key, value)) {
      throw new Error("durable activation response lost");
    }
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
    if (
      this.failReadsAfterActiveCommit &&
      this.activeTransitionFailuresAfterCommit > 0
    ) {
      throw new Error("durable read unavailable");
    }
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
    guard?: { key: string; expected: string },
  ): Promise<boolean> {
    if (guard && this.replaceGuardBeforeTransition) {
      const current = this.values.get(guard.key);
      if (current) current.value = "newer-challenge";
      this.replaceGuardBeforeTransition = false;
    }
    if (guard && this.values.get(guard.key)?.value !== guard.expected)
      return false;
    const entry = this.values.get(key);
    const current = entry && Date.now() <= entry.expiresAt ? entry.value : null;
    if (current !== expected && current !== desired) return false;
    if (this.failActiveWrites)
      throw new Error("durable activation unavailable");
    this.values.set(key, { value: desired, expiresAt: Date.now() + ttlMs });
    if (
      this.failActiveWritesAfterCommit &&
      this.activeTransitionFailuresAfterCommit++ === 0
    ) {
      throw new Error("durable activation response lost");
    }
    return true;
  }

  async publish(entries: readonly StorePublishEntry[]): Promise<boolean> {
    if (this.failWrites) throw new Error("durable store unavailable");
    const activationEntry = entries.find((entry) =>
      this.isActivation(entry.key, entry.value),
    );
    if (activationEntry) {
      this.activationPublishExpiresAt.push(activationEntry.expiresAt);
      if (
        this.failFirstActivationPublishAfterMs > 0 &&
        this.activationPublishExpiresAt.length === 1
      ) {
        await Bun.sleep(this.failFirstActivationPublishAfterMs);
        throw new Error("delayed durable activation failure");
      }
    }
    const now = Date.now();
    if (entries.some((entry) => entry.value !== null && entry.expiresAt <= now))
      return false;
    if (this.replaceGuardBeforeTransition) {
      const guardedTarget = entries.find(
        (entry) =>
          entry.expected !== undefined &&
          entry.key.startsWith("email-login:active:"),
      );
      if (guardedTarget) {
        this.values.set(guardedTarget.key, {
          value: "newer-challenge",
          expiresAt: now + 60_000,
        });
      }
      this.replaceGuardBeforeTransition = false;
    }
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
    if (activationEntry && this.delaySuccessfulActivationPublishMs > 0) {
      await Bun.sleep(this.delaySuccessfulActivationPublishMs);
    }
    if (
      entries.some(
        (entry) => entry.value !== null && entry.expiresAt <= Date.now(),
      )
    )
      return false;
    if (
      this.failActiveWrites &&
      entries.some((entry) => this.isActivation(entry.key, entry.value))
    ) {
      throw new Error("durable activation unavailable");
    }
    for (const entry of entries) {
      if (entry.value === null) this.values.delete(entry.key);
      else
        this.values.set(entry.key, {
          value: entry.value,
          expiresAt: entry.expiresAt,
        });
    }
    if (
      this.failActiveWritesAfterCommit &&
      entries.some((entry) => this.isActivation(entry.key, entry.value)) &&
      this.activeTransitionFailuresAfterCommit++ === 0
    ) {
      await this.afterActivationCommitBeforeLostAck?.();
      throw new Error("durable activation response lost");
    }
    return true;
  }

  async delete(key: string): Promise<void> {
    if (this.failDeletes) throw new Error("durable delete unavailable");
    this.values.delete(key);
  }
}

class DelayedMemoryPublishBackend extends MemoryBackend {
  delayNextPublishMs = 0;

  override async publish(
    entries: readonly StorePublishEntry[],
  ): Promise<boolean> {
    const delayMs = this.delayNextPublishMs;
    this.delayNextPublishMs = 0;
    if (delayMs > 0) await Bun.sleep(delayMs);
    return super.publish(entries);
  }
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_CODE_SECRET = process.env.STEWARD_EMAIL_CODE_SECRET;
const ORIGINAL_ALLOW_DEV_SECRETS = process.env.STEWARD_ALLOW_DEV_SECRETS;
const ORIGINAL_ALLOW_DEV_SECRET = process.env.STEWARD_ALLOW_DEV_SECRET;

function restoreEnv(): void {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_CODE_SECRET === undefined)
    delete process.env.STEWARD_EMAIL_CODE_SECRET;
  else process.env.STEWARD_EMAIL_CODE_SECRET = ORIGINAL_CODE_SECRET;
  if (ORIGINAL_ALLOW_DEV_SECRETS === undefined)
    delete process.env.STEWARD_ALLOW_DEV_SECRETS;
  else process.env.STEWARD_ALLOW_DEV_SECRETS = ORIGINAL_ALLOW_DEV_SECRETS;
  if (ORIGINAL_ALLOW_DEV_SECRET === undefined)
    delete process.env.STEWARD_ALLOW_DEV_SECRET;
  else process.env.STEWARD_ALLOW_DEV_SECRET = ORIGINAL_ALLOW_DEV_SECRET;
}

function buildAuth(
  provider: EmailProvider | undefined,
  backend: CapturingBackend,
  options: { tokenTtlMs?: number } = {},
): EmailAuth {
  return new EmailAuth({
    from: "login@steward.fi",
    baseUrl: "https://steward.fi",
    ...(provider ? { provider } : {}),
    tokenStore: new TokenStore({ backend }),
    codeVerifierSecret,
    ...options,
  });
}

function expectOpaqueBoundedPublicationReceipt(
  backend: CapturingBackend,
  canaries: readonly string[],
): void {
  const receipts = [...backend.values.entries()].filter(([key]) =>
    key.startsWith("email-issuance:published:"),
  );
  expect(receipts).toHaveLength(1);
  const [key, receipt] = requireLoginValue(receipts[0], "receipts[0]");
  expect(key).toMatch(/^email-issuance:published:[0-9a-f]{64}$/);
  expect(receipt.value).toMatch(/^published:[0-9a-f]{64}$/);
  expect(key.slice("email-issuance:published:".length)).toBe(
    receipt.value.slice("published:".length),
  );
  expect(receipt.expiresAt).toBeGreaterThan(Date.now());
  expect(receipt.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
  for (const canary of canaries)
    expect(`${key}:${receipt.value}`).not.toContain(canary);
}

async function legacyVerifyMagicLink(
  backend: StoreBackend,
  token: string,
): Promise<boolean> {
  const challengeId = await backend.consume(
    `email-login:link:${hashSha256Hex(token)}`,
  );
  if (!challengeId) return false;
  const stored = await backend.consume(`email-login:pending:${challengeId}`);
  if (!stored) return false;
  try {
    return (JSON.parse(stored) as { status?: unknown }).status === "pending";
  } catch {
    return false;
  }
}

async function legacyVerifyOtp(
  backend: StoreBackend,
  email: string,
  code: string,
  tenantId?: string,
): Promise<boolean> {
  const key = hashSha256Hex(`email-otp:${tenantId ?? ""}:${email}:${code}`);
  const stored = await backend.consume(key);
  if (!stored) return false;
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    return (
      parsed.email === email &&
      (parsed.tenantId === undefined || parsed.tenantId === tenantId) &&
      Object.keys(parsed).every((key) => key === "email" || key === "tenantId")
    );
  } catch {
    return stored === email;
  }
}

describe("fail-closed magic-link delivery", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("leaves a delivered-but-rejected challenge durably staged even when delete is unavailable", async () => {
    const backend = new CapturingBackend();
    backend.failDeletes = true;
    let text = "";
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          text = body; // capture what WOULD have been delivered, then reject
          throw new Error("Resend error: API key is invalid");
        },
      },
      backend,
    );

    await expect(
      auth.sendMagicLink("victim@example.com", { tenantId: "tenant-a" }),
    ).rejects.toThrow(EmailDeliveryError);

    const remaining = [...backend.values.keys()].filter((k) =>
      k.startsWith("email-login:"),
    );
    expect(remaining.length).toBeGreaterThan(0);
    expect(
      [...backend.values.values()].some((entry) =>
        entry.value.includes('"delivery_pending"'),
      ),
    ).toBe(true);
    expect(
      [...backend.values.values()].some((entry) =>
        entry.value.includes('"status":"active"'),
      ),
    ).toBe(false);

    const token = text.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    const code = text.match(/\b(\d{6})\b/)?.[1] ?? "";
    expect(token).not.toBe("");
    expect(code).not.toBe("");
    const linkResult = await auth.verifyMagicLink(
      token,
      "victim@example.com",
      "tenant-a",
    );
    expect(linkResult.valid).toBe(false);
    const codeResult = await auth.verifyEmailLoginCode(
      "victim@example.com",
      code,
      "tenant-a",
    );
    expect(codeResult.valid).toBe(false);

    auth.destroy();
  });

  it("bounds provider waits and keeps timed-out credentials staged", async () => {
    expect(
      () =>
        new EmailAuth({
          from: "login@steward.fi",
          baseUrl: "https://steward.fi",
          provider: new MockEmailProvider(),
          tokenStore: new TokenStore({ backend: new CapturingBackend() }),
          codeVerifierSecret,
          deliveryTimeoutMs: Number.MAX_SAFE_INTEGER,
        }),
    ).toThrow("deliveryTimeoutMs must be an integer between");

    const backend = new CapturingBackend();
    const auth = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider: { send: () => new Promise(() => {}) },
      tokenStore: new TokenStore({ backend }),
      codeVerifierSecret,
      deliveryTimeoutMs: 10,
    });
    await expect(auth.sendMagicLink("timeout@example.com")).rejects.toThrow(
      EmailDeliveryError,
    );
    expect(
      [...backend.values.keys()].some((key) =>
        key.startsWith("email-login:staging:"),
      ),
    ).toBe(false);
    auth.destroy();
  });

  it("redacts failures from hostile receipt getters", async () => {
    const backend = new CapturingBackend();
    const secret = "receipt-getter-secret-canary";
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const auth = buildAuth(
        {
          send: async () =>
            Object.defineProperty({}, "provider", {
              get: () => {
                throw new Error(secret);
              },
            }) as never,
        },
        backend,
      );
      await expect(auth.sendMagicLink("getter@example.com")).rejects.toThrow(
        EmailDeliveryError,
      );
      expect(JSON.stringify(errors)).not.toContain(secret);
      auth.destroy();
    } finally {
      console.error = originalError;
    }
  });

  it("treats a missing acceptance receipt as delivery failure without activating", async () => {
    const backend = new CapturingBackend();
    // Legacy void-returning provider: resolves but produces NO receipt.
    const voidProvider = {
      send: async () => undefined,
    } as unknown as EmailProvider;
    const auth = buildAuth(voidProvider, backend);

    await expect(
      auth.sendMagicLink("void@example.com", { tenantId: "tenant-a" }),
    ).rejects.toThrow(EmailDeliveryError);

    const remaining = [...backend.values.keys()].filter((k) =>
      k.startsWith("email-login:"),
    );
    expect(remaining).toEqual([]);
    expect(
      [...backend.values.values()].some((entry) =>
        entry.value.includes('"status":"active"'),
      ),
    ).toBe(false);

    auth.destroy();
  });

  it("rejects oversized and accessor-backed acceptance receipts without activating", async () => {
    for (const receipt of [
      { provider: "x".repeat(65) },
      { provider: "test", id: "x".repeat(513) },
      Object.defineProperty({}, "provider", {
        get() {
          throw new Error("receipt getter must not run");
        },
      }),
    ]) {
      const backend = new CapturingBackend();
      const auth = buildAuth(
        { send: async () => receipt as EmailDeliveryReceipt },
        backend,
      );
      await expect(
        auth.sendMagicLink("receipt@example.com", { tenantId: "tenant-a" }),
      ).rejects.toThrow(EmailDeliveryError);
      expect(
        [...backend.values.values()].some((entry) =>
          entry.value.includes('"status":"active"'),
        ),
      ).toBe(false);
      auth.destroy();
    }
  });

  it("succeeds and keeps the challenge redeemable when the provider returns a receipt", async () => {
    const backend = new CapturingBackend();
    let text = "";
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          text = body;
          return { provider: "test", id: "accepted-1" };
        },
      },
      backend,
    );

    const issued = await auth.sendMagicLink("ok@example.com", {
      tenantId: "tenant-a",
    });
    expect(
      await auth.getEmailLoginStatus(issued.challengeId, issued.pollSecret),
    ).toMatchObject({
      status: "pending",
    });
    const code = text.match(/\b(\d{6})\b/)?.[1] ?? "";
    const result = await auth.verifyEmailLoginCode(
      "ok@example.com",
      code,
      "tenant-a",
    );
    expect(result.valid).toBe(true);

    auth.destroy();
  });

  it("writes committed credentials in the legacy-readable rolling-deploy format", async () => {
    const backend = new CapturingBackend();
    let text = "";
    const writer = buildAuth(
      {
        send: async (_to, _subject, body) => {
          text = body;
          return { provider: "test", id: "rolling-compatible" };
        },
      },
      backend,
    );

    await writer.sendMagicLink("rolling@example.com", { tenantId: "tenant-a" });
    const linkAlias = [...backend.values.entries()].find(([key]) =>
      key.startsWith("email-login:link:"),
    )?.[1].value;
    expect(linkAlias).toBeTruthy();
    const oldMagicRecord = JSON.parse(
      backend.values.get(`email-login:pending:${linkAlias}`)?.value ?? "null",
    );
    expect(oldMagicRecord).toMatchObject({
      status: "pending",
      purpose: "email-login",
    });

    await writer.sendOtp("rolling@example.com", { tenantId: "tenant-a" });
    const otpKey = [...backend.values.entries()].find(([key]) =>
      key.startsWith("email-otp:active:"),
    )?.[1].value;
    const oldOtpRecord = JSON.parse(
      backend.values.get(otpKey ?? "")?.value ?? "null",
    );
    expect(oldOtpRecord).toEqual({
      email: "rolling@example.com",
      tenantId: "tenant-a",
    });
    expect(
      [...backend.values.keys()].some(
        (key) =>
          key.startsWith("email-login:staging:") ||
          key.startsWith("email-otp:staging:"),
      ),
    ).toBe(false);
    expect(text).not.toBe("");
    writer.destroy();
  });

  it("allows exactly one redemption across independent instances sharing a backend", async () => {
    const backend = new MemoryBackend();
    let text = "";
    const config = {
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider: {
        send: async (_to: string, _subject: string, body: string) => {
          text = body;
          return { provider: "test", id: "shared-backend" };
        },
      },
      codeVerifierSecret,
    };
    const writer = new EmailAuth({
      ...config,
      tokenStore: new TokenStore({ backend }),
    });
    const verifier = new EmailAuth({
      ...config,
      tokenStore: new TokenStore({ backend }),
    });
    await writer.sendMagicLink("multi@example.com", { tenantId: "tenant-a" });
    const token = text.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    const results = await Promise.all([
      writer.verifyMagicLink(token, "multi@example.com", "tenant-a"),
      verifier.verifyMagicLink(token, "multi@example.com", "tenant-a"),
    ]);
    expect(results.filter((result) => result.valid)).toHaveLength(1);
    writer.destroy();
    verifier.destroy();
    backend.destroy();
  });

  it("reads mixed-case OTP records issued by a legacy pod", async () => {
    const backend = new CapturingBackend();
    const auth = buildAuth(
      { send: async () => ({ provider: "test" }) },
      backend,
    );
    const code = "123456";
    const legacyEmail = "MixedCase@Example.com";
    const key = hashSha256Hex(`email-otp:tenant-a:${legacyEmail}:${code}`);
    await backend.set(
      key,
      JSON.stringify({ email: legacyEmail, tenantId: "tenant-a" }),
      60_000,
    );
    expect(await auth.verifyOtp(legacyEmail, code, "tenant-a")).toBe(true);
    expect(await auth.verifyOtp(legacyEmail, code, "tenant-a")).toBe(false);
    auth.destroy();
  });

  it("never leaks the recipient, token, code, or poll secret through the error or logs", async () => {
    const backend = new CapturingBackend();
    let text = "";
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      const auth = buildAuth(
        {
          send: async (to, _subject, body) => {
            text = body;
            throw new Error(`refused delivery to ${to}`);
          },
        },
        backend,
      );

      let thrown: unknown;
      try {
        await auth.sendMagicLink("secret-recipient@example.com", {
          tenantId: "tenant-a",
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(EmailDeliveryError);

      const token = text.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
      const code = text.match(/\b(\d{6})\b/)?.[1] ?? "";
      const message = (thrown as Error).message;
      const allLogs = logged.join("\n");
      for (const surface of [message, allLogs]) {
        expect(surface).not.toContain("secret-recipient");
        expect(surface).not.toContain("@example.com");
        expect(surface).not.toContain(token);
        expect(surface).not.toContain(code);
        expect(surface).not.toContain("refused delivery");
      }

      auth.destroy();
    } finally {
      console.error = originalError;
    }
  });

  it("leaves a rejected OTP durably staged and non-redeemable", async () => {
    const backend = new CapturingBackend();
    backend.failDeletes = true;
    let text = "";
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          text = body;
          throw new Error("provider down");
        },
      },
      backend,
    );

    await expect(
      auth.sendOtp("otp@example.com", { tenantId: "tenant-a" }),
    ).rejects.toThrow(EmailDeliveryError);

    expect(
      [...backend.values.keys()].some((key) =>
        key.startsWith("email-otp:staging:"),
      ),
    ).toBe(false);
    const code = text.match(/\b(\d{6})\b/)?.[1] ?? "";
    expect(code).not.toBe("");
    expect(await auth.verifyOtp("otp@example.com", code, "tenant-a")).toBe(
      false,
    );

    auth.destroy();
  });

  it("does not redeem a magic link or companion code while delivery is in flight", async () => {
    const backend = new CapturingBackend();
    let text = "";
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          text = body;
          await accepted;
          return { provider: "test", id: "accepted-after-race" };
        },
      },
      backend,
    );

    const sending = auth.sendMagicLink("race@example.com", {
      tenantId: "tenant-a",
    });
    while (!text) await Bun.sleep(1);
    const token = text.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    const code = text.match(/\b(\d{6})\b/)?.[1] ?? "";

    expect(
      await auth.verifyMagicLink(token, "race@example.com", "tenant-a"),
    ).toMatchObject({
      valid: false,
    });
    expect(
      await auth.verifyEmailLoginCode("race@example.com", code, "tenant-a"),
    ).toMatchObject({
      valid: false,
    });

    accept();
    await sending;
    expect(
      await auth.verifyMagicLink(token, "race@example.com", "tenant-a"),
    ).toMatchObject({
      valid: true,
    });
    auth.destroy();
  });

  it("does not redeem an OTP while delivery is in flight", async () => {
    const backend = new CapturingBackend();
    let text = "";
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          text = body;
          await accepted;
          return { provider: "test", id: "accepted-otp-after-race" };
        },
      },
      backend,
    );

    const sending = auth.sendOtp("otp-race@example.com", {
      tenantId: "tenant-a",
    });
    while (!text) await Bun.sleep(1);
    const code = text.match(/\b(\d{6})\b/)?.[1] ?? "";
    expect(await auth.verifyOtp("otp-race@example.com", code, "tenant-a")).toBe(
      false,
    );

    accept();
    await sending;
    expect(await auth.verifyOtp("otp-race@example.com", code, "tenant-a")).toBe(
      true,
    );
    auth.destroy();
  });

  it("keeps magic-link staging invisible to an old pod during provider acceptance", async () => {
    const backend = new CapturingBackend();
    let text = "";
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          text = body;
          await accepted;
          return { provider: "test", id: "accepted-after-legacy-probe" };
        },
      },
      backend,
    );

    const sending = auth.sendMagicLink("legacy-race@example.com", {
      tenantId: "tenant-a",
    });
    while (!text) await Bun.sleep(1);
    const token = text.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    expect(token).not.toBe("");
    expect(await legacyVerifyMagicLink(backend, token)).toBe(false);

    accept();
    await sending;
    expect(
      await auth.verifyMagicLink(token, "legacy-race@example.com", "tenant-a"),
    ).toMatchObject({
      valid: true,
    });
    auth.destroy();
  });

  it("keeps OTP staging invisible and free of aliases or recipient PII", async () => {
    const backend = new CapturingBackend();
    let text = "";
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const email = "otp-staging@example.com";
    const tenantId = "tenant-a";
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          text = body;
          await accepted;
          return { provider: "test", id: "accepted-opaque-otp" };
        },
      },
      backend,
    );

    const sending = auth.sendOtp(email, { tenantId });
    while (!text) await Bun.sleep(1);
    const code = text.match(/\b(\d{6})\b/)?.[1] ?? "";
    expect(code).not.toBe("");
    const legacyStoreKey = hashSha256Hex(
      `email-otp:${tenantId}:${email}:${code}`,
    );
    const stagedKeys = [...backend.values.keys()];
    const stagedValues = [...backend.values.values()].map(({ value }) => value);

    accept();
    await sending;

    expect(stagedKeys).not.toContain(legacyStoreKey);
    expect(stagedKeys.some((key) => key.startsWith("email-otp:active:"))).toBe(
      false,
    );
    expect(stagedValues.some((value) => value.includes(email))).toBe(false);
    expect(stagedValues.some((value) => value.includes(code))).toBe(false);
    expect(await auth.verifyOtp(email, code, tenantId)).toBe(true);
    auth.destroy();
  });

  it("does not let an old pod consume an OTP while provider acceptance is pending", async () => {
    const backend = new CapturingBackend();
    let text = "";
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const email = "legacy-otp-race@example.com";
    const tenantId = "tenant-a";
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          text = body;
          await accepted;
          return { provider: "test", id: "accepted-after-legacy-otp-probe" };
        },
      },
      backend,
    );

    const sending = auth.sendOtp(email, { tenantId });
    while (!text) await Bun.sleep(1);
    const code = text.match(/\b(\d{6})\b/)?.[1] ?? "";
    expect(code).not.toBe("");
    expect(await legacyVerifyOtp(backend, email, code, tenantId)).toBe(false);

    accept();
    await sending;
    expect(await legacyVerifyOtp(backend, email, code, tenantId)).toBe(true);
    auth.destroy();
  });

  it("does not call the provider when durable staging fails", async () => {
    const backend = new CapturingBackend();
    backend.failWrites = true;
    let sends = 0;
    const auth = buildAuth(
      {
        send: async () => {
          sends += 1;
          return { provider: "test" };
        },
      },
      backend,
    );

    await expect(
      auth.sendMagicLink("store-down@example.com", { tenantId: "tenant-a" }),
    ).rejects.toThrow("durable store unavailable");
    await expect(
      auth.sendOtp("store-down@example.com", { tenantId: "tenant-a" }),
    ).rejects.toThrow("durable store unavailable");
    expect(sends).toBe(0);
    auth.destroy();
  });

  it("keeps accepted magic-link and OTP credentials non-redeemable when activation storage fails", async () => {
    const magicBackend = new CapturingBackend();
    let magicText = "";
    const magicAuth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          magicText = body;
          magicBackend.failActiveWrites = true;
          return { provider: "test", id: "accepted-magic" };
        },
      },
      magicBackend,
    );
    await expect(
      magicAuth.sendMagicLink("activation@example.com", {
        tenantId: "tenant-a",
      }),
    ).rejects.toThrow(EmailDeliveryError);
    const token = magicText.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    const companionCode = magicText.match(/\b(\d{6})\b/)?.[1] ?? "";
    expect(
      await magicAuth.verifyMagicLink(
        token,
        "activation@example.com",
        "tenant-a",
      ),
    ).toMatchObject({ valid: false });
    expect(
      await magicAuth.verifyEmailLoginCode(
        "activation@example.com",
        companionCode,
        "tenant-a",
      ),
    ).toMatchObject({ valid: false });

    const otpBackend = new CapturingBackend();
    let otpText = "";
    const otpAuth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          otpText = body;
          otpBackend.failActiveWrites = true;
          return { provider: "test", id: "accepted-otp" };
        },
      },
      otpBackend,
    );
    await expect(
      otpAuth.sendOtp("activation-otp@example.com", { tenantId: "tenant-a" }),
    ).rejects.toThrow(EmailDeliveryError);
    const otpCode = otpText.match(/\b(\d{6})\b/)?.[1] ?? "";
    expect(
      await otpAuth.verifyOtp(
        "activation-otp@example.com",
        otpCode,
        "tenant-a",
      ),
    ).toBe(false);

    magicAuth.destroy();
    otpAuth.destroy();
  });

  it("confirms a committed activation when the storage acknowledgement is lost", async () => {
    const backend = new CapturingBackend();
    let text = "";
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          text = body;
          backend.failActiveWritesAfterCommit = true;
          backend.failReadsAfterActiveCommit = true;
          return { provider: "test", id: "accepted-before-ack-loss" };
        },
      },
      backend,
    );

    await auth.sendMagicLink("ack-loss@example.com", { tenantId: "tenant-a" });
    expect(backend.activeTransitionFailuresAfterCommit).toBe(1);
    backend.failReadsAfterActiveCommit = false;
    const token = text.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    expect(
      await auth.verifyMagicLink(token, "ack-loss@example.com", "tenant-a"),
    ).toMatchObject({
      valid: true,
    });
    auth.destroy();
  });

  it("retries an OTP publish idempotently after the activation acknowledgement is lost", async () => {
    const backend = new CapturingBackend();
    let text = "";
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          text = body;
          backend.failActiveWritesAfterCommit = true;
          return { provider: "test", id: "accepted-otp-before-ack-loss" };
        },
      },
      backend,
    );

    await auth.sendOtp("otp-ack-loss@example.com", { tenantId: "tenant-a" });
    expect(backend.activeTransitionFailuresAfterCommit).toBe(1);
    const code = text.match(/\b(\d{6})\b/)?.[1] ?? "";
    expect(
      await auth.verifyOtp("otp-ack-loss@example.com", code, "tenant-a"),
    ).toBe(true);
    auth.destroy();
  });

  it("preserves the absolute expiry when a delayed publish failure is retried successfully", async () => {
    const backend = new CapturingBackend();
    backend.failFirstActivationPublishAfterMs = 120;
    let text = "";
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          text = body;
          return { provider: "test", id: "accepted-before-delayed-publish" };
        },
      },
      backend,
      { tokenTtlMs: 500 },
    );

    const { expiresAt } = await auth.sendOtp("otp-delayed-retry@example.com", {
      tenantId: "tenant-a",
    });

    expect(backend.activationPublishExpiresAt).toHaveLength(2);
    expect(backend.activationPublishExpiresAt[1]).toBe(
      backend.activationPublishExpiresAt[0],
    );
    for (const entry of backend.values.values()) {
      expect(entry.expiresAt).toBeLessThanOrEqual(expiresAt.getTime());
    }
    const code = text.match(/\b(\d{6})\b/)?.[1] ?? "";
    expect(
      await auth.verifyOtp("otp-delayed-retry@example.com", code, "tenant-a"),
    ).toBe(true);
    auth.destroy();
  });

  it("fails OTP activation when publication is delayed past its advertised expiry", async () => {
    const backend = new CapturingBackend();
    backend.delaySuccessfulActivationPublishMs = 80;
    let text = "";
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          text = body;
          return { provider: "test", id: "accepted-before-expired-publish" };
        },
      },
      backend,
      { tokenTtlMs: 40 },
    );

    await expect(
      auth.sendOtp("otp-expired-publish@example.com", { tenantId: "tenant-a" }),
    ).rejects.toThrow("Email challenge activation failed");
    expect(backend.activationPublishExpiresAt).toHaveLength(1);
    const code = text.match(/\b(\d{6})\b/)?.[1] ?? "";
    expect(
      await auth.verifyOtp("otp-expired-publish@example.com", code, "tenant-a"),
    ).toBe(false);
    auth.destroy();
  });

  it("fails magic-link activation when publication is delayed past its advertised expiry", async () => {
    const backend = new CapturingBackend();
    backend.delaySuccessfulActivationPublishMs = 80;
    let text = "";
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          text = body;
          return {
            provider: "test",
            id: "accepted-before-expired-magic-publish",
          };
        },
      },
      backend,
      { tokenTtlMs: 40 },
    );

    await expect(
      auth.sendMagicLink("magic-expired-publish@example.com", {
        tenantId: "tenant-a",
      }),
    ).rejects.toThrow("Email challenge activation failed");
    const token = text.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    const code = text.match(/\b(\d{6})\b/)?.[1] ?? "";
    expect(
      await auth.verifyMagicLink(
        token,
        "magic-expired-publish@example.com",
        "tenant-a",
      ),
    ).toMatchObject({ valid: false });
    expect(
      await auth.verifyEmailLoginCode(
        "magic-expired-publish@example.com",
        code,
        "tenant-a",
      ),
    ).toMatchObject({ valid: false });
    auth.destroy();
  });

  it("preserves the prior memory OTP when a delayed replacement passes its deadline", async () => {
    const backend = new DelayedMemoryPublishBackend();
    let priorText = "";
    const prior = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider: {
        send: async (_to, _subject, body) => {
          priorText = body;
          return { provider: "test", id: "prior-memory-otp" };
        },
      },
      tokenStore: new TokenStore({ backend }),
      tokenTtlMs: 60_000,
      codeVerifierSecret,
    });
    const delayed = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider: {
        send: async () => {
          backend.delayNextPublishMs = 80;
          return { provider: "test", id: "expired-memory-otp" };
        },
      },
      tokenStore: new TokenStore({ backend }),
      tokenTtlMs: 40,
      codeVerifierSecret,
    });

    await prior.sendOtp("memory-prior-otp@example.com", {
      tenantId: "tenant-a",
    });
    const priorCode = priorText.match(/\b(\d{6})\b/)?.[1] ?? "";
    await expect(
      delayed.sendOtp("memory-prior-otp@example.com", { tenantId: "tenant-a" }),
    ).rejects.toThrow(EmailDeliveryError);
    expect(
      await prior.verifyOtp(
        "memory-prior-otp@example.com",
        priorCode,
        "tenant-a",
      ),
    ).toBe(true);
    backend.destroy();
  });

  it("preserves the prior memory magic link when a delayed replacement passes its deadline", async () => {
    const backend = new DelayedMemoryPublishBackend();
    let priorText = "";
    const prior = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider: {
        send: async (_to, _subject, body) => {
          priorText = body;
          return { provider: "test", id: "prior-memory-magic" };
        },
      },
      tokenStore: new TokenStore({ backend }),
      tokenTtlMs: 60_000,
      codeVerifierSecret,
    });
    const delayed = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider: {
        send: async () => {
          backend.delayNextPublishMs = 80;
          return { provider: "test", id: "expired-memory-magic" };
        },
      },
      tokenStore: new TokenStore({ backend }),
      tokenTtlMs: 40,
      codeVerifierSecret,
    });

    await prior.sendMagicLink("memory-prior-magic@example.com", {
      tenantId: "tenant-a",
    });
    const priorToken = priorText.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    await expect(
      delayed.sendMagicLink("memory-prior-magic@example.com", {
        tenantId: "tenant-a",
      }),
    ).rejects.toThrow(EmailDeliveryError);
    expect(
      await prior.verifyMagicLink(
        priorToken,
        "memory-prior-magic@example.com",
        "tenant-a",
      ),
    ).toMatchObject({ valid: true });
    backend.destroy();
  });

  it("confirms a magic-link commit after lost acknowledgement and a newer failed reservation", async () => {
    const backend = new CapturingBackend();
    let firstText = "";
    let secondProviderStarted!: () => void;
    const secondProviderEntered = new Promise<void>((resolve) => {
      secondProviderStarted = resolve;
    });
    let rejectSecond!: (reason: unknown) => void;
    const secondProviderResult = new Promise<never>((_resolve, reject) => {
      rejectSecond = reject;
    });
    const first = buildAuth(
      {
        send: async (_to, _subject, body) => {
          firstText = body;
          backend.failActiveWritesAfterCommit = true;
          return { provider: "test", id: "first-committed-before-ack-loss" };
        },
      },
      backend,
    );
    const second = buildAuth(
      {
        send: async () => {
          secondProviderStarted();
          return secondProviderResult;
        },
      },
      backend,
    );
    let secondSend: Promise<unknown> | undefined;
    backend.afterActivationCommitBeforeLostAck = async () => {
      secondSend = second.sendMagicLink("ack-reservation@example.com", {
        tenantId: "tenant-a",
      });
      await secondProviderEntered;
    };

    await first.sendMagicLink("ack-reservation@example.com", {
      tenantId: "tenant-a",
    });
    rejectSecond(new Error("SECOND_PROVIDER_SECRET_CANARY"));
    if (!secondSend) throw new Error("newer issuance did not start");
    await expect(secondSend).rejects.toThrow(EmailDeliveryError);

    const token = firstText.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    expectOpaqueBoundedPublicationReceipt(backend, [
      "ack-reservation@example.com",
      "tenant-a",
      token,
    ]);
    expect(
      await first.verifyMagicLink(
        token,
        "ack-reservation@example.com",
        "tenant-a",
      ),
    ).toMatchObject({ valid: true });
    first.destroy();
    second.destroy();
  });

  it("confirms an OTP commit after lost acknowledgement and a newer failed reservation", async () => {
    const backend = new CapturingBackend();
    let firstText = "";
    let secondProviderStarted!: () => void;
    const secondProviderEntered = new Promise<void>((resolve) => {
      secondProviderStarted = resolve;
    });
    let rejectSecond!: (reason: unknown) => void;
    const secondProviderResult = new Promise<never>((_resolve, reject) => {
      rejectSecond = reject;
    });
    const first = buildAuth(
      {
        send: async (_to, _subject, body) => {
          firstText = body;
          backend.failActiveWritesAfterCommit = true;
          return {
            provider: "test",
            id: "first-otp-committed-before-ack-loss",
          };
        },
      },
      backend,
    );
    const second = buildAuth(
      {
        send: async () => {
          secondProviderStarted();
          return secondProviderResult;
        },
      },
      backend,
    );
    let secondSend: Promise<unknown> | undefined;
    backend.afterActivationCommitBeforeLostAck = async () => {
      secondSend = second.sendOtp("otp-ack-reservation@example.com", {
        tenantId: "tenant-a",
      });
      await secondProviderEntered;
    };

    await first.sendOtp("otp-ack-reservation@example.com", {
      tenantId: "tenant-a",
    });
    rejectSecond(new Error("SECOND_PROVIDER_SECRET_CANARY"));
    if (!secondSend) throw new Error("newer OTP issuance did not start");
    await expect(secondSend).rejects.toThrow(EmailDeliveryError);

    const code = firstText.match(/\b(\d{6})\b/)?.[1] ?? "";
    expectOpaqueBoundedPublicationReceipt(backend, [
      "otp-ack-reservation@example.com",
      "tenant-a",
      code,
    ]);
    expect(
      await first.verifyOtp(
        "otp-ack-reservation@example.com",
        code,
        "tenant-a",
      ),
    ).toBe(true);
    first.destroy();
    second.destroy();
  });

  it("keeps only the newest concurrently published challenge across independent instances", async () => {
    const backend = new CapturingBackend();
    let firstText = "";
    let secondText = "";
    let acceptFirst!: () => void;
    let acceptSecond!: () => void;
    const firstAccepted = new Promise<void>((resolve) => {
      acceptFirst = resolve;
    });
    const secondAccepted = new Promise<void>((resolve) => {
      acceptSecond = resolve;
    });
    const first = buildAuth(
      {
        send: async (_to, _subject, body) => {
          firstText = body;
          await firstAccepted;
          return { provider: "test", id: "first-independent" };
        },
      },
      backend,
    );
    const second = buildAuth(
      {
        send: async (_to, _subject, body) => {
          secondText = body;
          await secondAccepted;
          return { provider: "test", id: "second-independent" };
        },
      },
      backend,
    );

    const firstSend = first.sendMagicLink("independent@example.com", {
      tenantId: "tenant-a",
    });
    while (!firstText) await Bun.sleep(1);
    const secondSend = second.sendMagicLink("independent@example.com", {
      tenantId: "tenant-a",
    });
    while (!secondText) await Bun.sleep(1);
    acceptSecond();
    await secondSend;
    acceptFirst();
    await expect(firstSend).rejects.toThrow(EmailDeliveryError);

    const firstToken = firstText.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    const secondToken = secondText.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    expect(
      await first.verifyMagicLink(
        firstToken,
        "independent@example.com",
        "tenant-a",
      ),
    ).toMatchObject({ valid: false });
    expect(
      await second.verifyMagicLink(
        secondToken,
        "independent@example.com",
        "tenant-a",
      ),
    ).toMatchObject({ valid: true });
    first.destroy();
    second.destroy();
  });

  it("keeps only the newest concurrently delivered challenge redeemable", async () => {
    const backend = new CapturingBackend();
    const messages: string[] = [];
    const accepts: Array<() => void> = [];
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          messages.push(body);
          await new Promise<void>((resolve) => accepts.push(resolve));
          return { provider: "test", id: `accepted-${messages.length}` };
        },
      },
      backend,
    );

    const firstSend = auth.sendMagicLink("supersede@example.com", {
      tenantId: "tenant-a",
    });
    while (messages.length < 1) await Bun.sleep(1);
    const secondSend = auth.sendMagicLink("supersede@example.com", {
      tenantId: "tenant-a",
    });
    while (messages.length < 2) await Bun.sleep(1);
    accepts[1]?.();
    await secondSend;
    accepts[0]?.();
    await expect(firstSend).rejects.toThrow(EmailDeliveryError);

    const firstToken =
      messages[0]?.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    const secondToken =
      messages[1]?.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    expect(
      await auth.verifyMagicLink(
        firstToken,
        "supersede@example.com",
        "tenant-a",
      ),
    ).toMatchObject({ valid: false });
    expect(
      await auth.verifyMagicLink(
        secondToken,
        "supersede@example.com",
        "tenant-a",
      ),
    ).toMatchObject({ valid: true });
    auth.destroy();
  });

  it("does not activate after the target is superseded at the commit boundary", async () => {
    const backend = new CapturingBackend();
    let text = "";
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          text = body;
          backend.replaceGuardBeforeTransition = true;
          return { provider: "test", id: "accepted-before-supersede" };
        },
      },
      backend,
    );

    await expect(
      auth.sendMagicLink("commit-race@example.com", { tenantId: "tenant-a" }),
    ).rejects.toThrow(EmailDeliveryError);
    const token = text.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    expect(
      await auth.verifyMagicLink(token, "commit-race@example.com", "tenant-a"),
    ).toMatchObject({
      valid: false,
    });
    auth.destroy();
  });

  it("supersedes an accepted OTP when the same target retries", async () => {
    const backend = new CapturingBackend();
    const messages: string[] = [];
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          messages.push(body);
          return { provider: "test", id: `accepted-${messages.length}` };
        },
      },
      backend,
    );

    await auth.sendOtp("otp-retry@example.com", { tenantId: "tenant-a" });
    await auth.sendOtp("otp-retry@example.com", { tenantId: "tenant-a" });
    const firstCode = messages[0]?.match(/\b(\d{6})\b/)?.[1] ?? "";
    const secondCode = messages[1]?.match(/\b(\d{6})\b/)?.[1] ?? "";
    expect(
      await auth.verifyOtp("otp-retry@example.com", firstCode, "tenant-a"),
    ).toBe(false);
    expect(
      await auth.verifyOtp("otp-retry@example.com", secondCode, "tenant-a"),
    ).toBe(true);
    auth.destroy();
  });

  it("redeems active wrapper records emitted before the rolling-format fix", async () => {
    const backend = new CapturingBackend();
    const messages: string[] = [];
    const auth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          messages.push(body);
          return { provider: "test", id: `accepted-${messages.length}` };
        },
      },
      backend,
    );

    await auth.sendMagicLink("active-wrapper@example.com", {
      tenantId: "tenant-a",
    });
    const magicRecord = [...backend.values.values()].find((entry) =>
      entry.value.includes('"purpose":"email-login"'),
    );
    expect(magicRecord).toBeDefined();
    if (magicRecord) {
      magicRecord.value = JSON.stringify({
        ...JSON.parse(magicRecord.value),
        status: "active",
      });
    }
    const token = messages[0]?.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    expect(
      await auth.verifyMagicLink(
        token,
        "active-wrapper@example.com",
        "tenant-a",
      ),
    ).toMatchObject({ valid: true });

    await auth.sendOtp("active-wrapper-otp@example.com", {
      tenantId: "tenant-a",
    });
    const otpRecord = [...backend.values.entries()].find(
      ([key]) => key.length === 64,
    );
    expect(otpRecord).toBeDefined();
    if (otpRecord) {
      otpRecord[1].value = JSON.stringify({
        status: "active",
        payload: {
          email: "active-wrapper-otp@example.com",
          tenantId: "tenant-a",
        },
      });
    }
    const otpCode = messages[1]?.match(/\b(\d{6})\b/)?.[1] ?? "";
    expect(
      await auth.verifyOtp(
        "active-wrapper-otp@example.com",
        otpCode,
        "tenant-a",
      ),
    ).toBe(true);

    auth.destroy();
  });

  it("rejects malformed active magic-link and OTP records", async () => {
    const magicBackend = new CapturingBackend();
    let magicText = "";
    const magicAuth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          magicText = body;
          return { provider: "test" };
        },
      },
      magicBackend,
    );
    await magicAuth.sendMagicLink("malformed@example.com", {
      tenantId: "tenant-a",
    });
    const magicRecord = [...magicBackend.values.entries()].find(
      ([key, entry]) =>
        key.startsWith("email-login:pending:") &&
        entry.value.includes('"purpose":"email-login"') &&
        entry.value.includes('"status":"pending"'),
    );
    expect(magicRecord).toBeDefined();
    if (magicRecord) magicRecord[1].value = "{";
    const token = magicText.match(/[?&]token=([a-f0-9]{64})/)?.[1] ?? "";
    expect(
      await magicAuth.verifyMagicLink(
        token,
        "malformed@example.com",
        "tenant-a",
      ),
    ).toMatchObject({ valid: false });

    const otpBackend = new CapturingBackend();
    let otpText = "";
    const otpAuth = buildAuth(
      {
        send: async (_to, _subject, body) => {
          otpText = body;
          return { provider: "test" };
        },
      },
      otpBackend,
    );
    await otpAuth.sendOtp("malformed-otp@example.com", {
      tenantId: "tenant-a",
    });
    const otpRecord = [...otpBackend.values.entries()].find(
      ([key, entry]) =>
        key.length === 64 &&
        entry.value.includes('"email":"malformed-otp@example.com"'),
    );
    expect(otpRecord).toBeDefined();
    if (otpRecord) {
      otpRecord[1].value = JSON.stringify({
        status: "failed",
        email: "malformed-otp@example.com",
        tenantId: "tenant-a",
      });
    }
    const otpCode = otpText.match(/\b(\d{6})\b/)?.[1] ?? "";
    expect(
      await otpAuth.verifyOtp("malformed-otp@example.com", otpCode, "tenant-a"),
    ).toBe(false);

    magicAuth.destroy();
    otpAuth.destroy();
  });
});

describe("production requires a delivery-capable provider", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("throws EmailDeliveryNotConfiguredError BEFORE storing any challenge state", async () => {
    process.env.NODE_ENV = "production";
    process.env.STEWARD_EMAIL_CODE_SECRET = "prod-test-email-code-secret";
    const backend = new CapturingBackend();
    const auth = buildAuth(undefined, backend); // silent ConsoleProvider fallback

    await expect(
      auth.sendMagicLink("prod@example.com", { tenantId: "tenant-a" }),
    ).rejects.toThrow(EmailDeliveryNotConfiguredError);
    await expect(
      auth.sendOtp("prod@example.com", { tenantId: "tenant-a" }),
    ).rejects.toThrow(EmailDeliveryNotConfiguredError);
    await expect(
      auth.sendTenantInvitation("prod@example.com", {
        tenantId: "tenant-a",
        token: "b".repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(EmailDeliveryNotConfiguredError);

    // No challenge was ever issued — nothing to invalidate, nothing to redeem.
    expect(backend.values.size).toBe(0);

    auth.destroy();
  });

  it("rejects an explicitly passed ConsoleProvider in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.STEWARD_EMAIL_CODE_SECRET = "prod-test-email-code-secret";
    const backend = new CapturingBackend();
    const auth = buildAuth(new ConsoleProvider(), backend);

    await expect(auth.sendMagicLink("console@example.com")).rejects.toThrow(
      EmailDeliveryNotConfiguredError,
    );
    expect(backend.values.size).toBe(0);

    auth.destroy();
  });

  it("still allows the ConsoleProvider fallback outside production", async () => {
    const backend = new CapturingBackend();
    const originalLog = console.log;
    console.log = () => {};
    try {
      const auth = buildAuth(undefined, backend);
      const issued = await auth.sendMagicLink("dev@example.com", {
        tenantId: "tenant-a",
      });
      expect(issued.challengeId).toMatch(/^[a-f0-9]{64}$/);
      auth.destroy();
    } finally {
      console.log = originalLog;
    }
  });
});

describe("email code verifier secret hardening", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("rejects missing and weak verifier secrets in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.STEWARD_EMAIL_CODE_SECRET;
    expect(
      () =>
        new EmailAuth({
          from: "login@steward.fi",
          baseUrl: "https://steward.fi",
          provider: new MockEmailProvider(),
        }),
    ).toThrow("STEWARD_EMAIL_CODE_SECRET is required");

    expect(
      () =>
        new EmailAuth({
          from: "login@steward.fi",
          baseUrl: "https://steward.fi",
          provider: new MockEmailProvider(),
          codeVerifierSecret: "short-secret",
        }),
    ).toThrow("must be at least 32 characters");
  });

  it("requires explicit opt-in before using the deterministic development secret", () => {
    process.env.NODE_ENV = "development";
    delete process.env.STEWARD_EMAIL_CODE_SECRET;
    delete process.env.STEWARD_ALLOW_DEV_SECRETS;
    delete process.env.STEWARD_ALLOW_DEV_SECRET;
    const config = {
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider: new MockEmailProvider(),
    };

    expect(() => new EmailAuth(config)).toThrow(
      "STEWARD_ALLOW_DEV_SECRETS=true",
    );
    process.env.STEWARD_ALLOW_DEV_SECRETS = "true";
    const allowed = new EmailAuth(config);
    allowed.destroy();
  });
});

describe("acceptance receipts per provider", () => {
  afterEach(() => {
    MockEmailInbox.clear();
  });

  it("ResendProvider returns {provider:'resend', id} on acceptance and throws on error", async () => {
    const provider = new ResendProvider({
      apiKey: "test",
      from: "Steward <login@steward.fi>",
    });

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = Object.assign(
        async () => Response.json({ id: "resend-msg-1" }),
        originalFetch,
      );
      expect(await provider.send("a@example.com", "s", "t")).toEqual({
        provider: "resend",
        id: "resend-msg-1",
      });
      globalThis.fetch = Object.assign(
        async () => Response.json({}),
        originalFetch,
      );
      await expect(provider.send("a@example.com", "s", "t")).rejects.toThrow(
        "no delivery acceptance id",
      );
      globalThis.fetch = Object.assign(
        async () =>
          Response.json(
            { message: "invalid api key", name: "validation_error" },
            { status: 403 },
          ),
        originalFetch,
      );
      await expect(provider.send("a@example.com", "s", "t")).rejects.toThrow(
        "Resend error",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ConsoleProvider and MockEmailProvider return redacted receipts", async () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      expect(
        await new ConsoleProvider().send("a@example.com", "s", "t"),
      ).toEqual({
        provider: "console",
      });
    } finally {
      console.log = originalLog;
    }

    const mockReceipt = await new MockEmailProvider().send(
      "a@example.com",
      "s",
      "t",
    );
    expect(mockReceipt.provider).toBe("mock");
    expect(mockReceipt.id).toBeTruthy();
    expect(MockEmailInbox.last("a@example.com")?.subject).toBe("s");
  });
});
