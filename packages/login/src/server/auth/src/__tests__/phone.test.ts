import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { requireLoginValue } from "../../../../required";

import { isValidE164, PhoneAuth } from "../phone";
import {
  type ManagedOtpDeliveryChannel,
  type ManagedSmsOtpProvider,
  MockSmsInbox,
  MockSmsProvider,
  SmsVerificationError,
  SmsVerificationNotAttemptedError,
} from "../sms-provider";
import { MemoryBackend } from "../store-backends";
import { TokenStore } from "../token-store";

function makeAuth(
  opts: Partial<ConstructorParameters<typeof PhoneAuth>[0]> = {},
) {
  return new PhoneAuth({ provider: new MockSmsProvider(), ...opts });
}

class ManagedProviderDouble implements ManagedSmsOtpProvider {
  readonly challengeTtlMs = 10 * 60 * 1000;
  readonly operationLockTtlMs = 30 * 1000;
  readonly reservationTtlMs = this.challengeTtlMs + 2 * this.operationLockTtlMs;
  readonly sends: string[] = [];
  readonly sendAttempts: string[] = [];
  readonly sendChannels: ManagedOtpDeliveryChannel[] = [];
  readonly checks: Array<{ phone: string; code: string }> = [];
  rejectNextSend = false;
  rejectNextVerify = false;
  sendHook?: () => Promise<void>;
  verifyHook?: () => Promise<void>;
  challengeExpiresAt: number | null = null;

  async send(
    phone: string,
    channel: ManagedOtpDeliveryChannel,
  ): Promise<{ expiresAt: Date }> {
    this.sendAttempts.push(phone);
    this.sendChannels.push(channel);
    await this.sendHook?.();
    if (this.rejectNextSend) {
      this.rejectNextSend = false;
      throw new Error("provider rejected send");
    }
    if (
      this.challengeExpiresAt === null ||
      this.challengeExpiresAt <= Date.now()
    ) {
      this.challengeExpiresAt = Date.now() + this.challengeTtlMs;
    }
    this.sends.push(phone);
    return { expiresAt: new Date(this.challengeExpiresAt) };
  }

  async verify(phone: string, code: string): Promise<boolean> {
    this.checks.push({ phone, code });
    await this.verifyHook?.();
    if (this.rejectNextVerify) {
      this.rejectNextVerify = false;
      throw new Error("provider check outcome unknown");
    }
    const approved = code === "123456";
    if (approved) this.challengeExpiresAt = null;
    return approved;
  }
}

class FaultingReservationBackend extends MemoryBackend {
  failTransitions = false;
  failActivePublication = false;
  failReads = false;

  override async get(key: string): Promise<string | null> {
    if (this.failReads) throw new Error("reservation store unavailable");
    return super.get(key);
  }

  override async transition(
    key: string,
    expected: string,
    desired: string,
    ttlMs: number,
    guard?: { key: string; expected: string },
  ): Promise<boolean> {
    if (this.failTransitions) throw new Error("reservation store unavailable");
    if (
      this.failActivePublication &&
      desired.includes('"challengeExpiresAt":') &&
      !desired.includes('"challengeExpiresAt":null')
    ) {
      throw new Error("reservation store unavailable");
    }
    return super.transition(key, expected, desired, ttlMs, guard);
  }
}

class LeaseExpiringBeforeProviderBackend extends MemoryBackend {
  setIfNotExistsCalls = 0;

  override async setIfNotExists(
    key: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean> {
    this.setIfNotExistsCalls++;
    if (this.setIfNotExistsCalls === 2) {
      setSystemTime(new Date(Date.now() + ttlMs + 1));
    }
    return super.setIfNotExists(key, value, ttlMs);
  }
}

afterEach(() => {
  setSystemTime();
  MockSmsInbox.clear();
});

describe("isValidE164", () => {
  test("accepts standard E.164", () => {
    expect(isValidE164("+14155551234")).toBe(true);
    expect(isValidE164("+447700900000")).toBe(true);
  });

  test("rejects local formats and garbage", () => {
    expect(isValidE164("4155551234")).toBe(false);
    expect(isValidE164("+1-415-555-1234")).toBe(false);
    expect(isValidE164("+0123")).toBe(false);
    expect(isValidE164("")).toBe(false);
    expect(isValidE164(null)).toBe(false);
  });
});

describe("PhoneAuth", () => {
  test("sendOtp dispatches a 6-digit code via the provider", async () => {
    const auth = makeAuth();
    try {
      const phone = "+14155551111";
      await auth.sendOtp(phone, "login", "sms");
      const msg = MockSmsInbox.last(phone);
      expect(msg?.code).toMatch(/^\d{6}$/);
    } finally {
      auth.destroy();
    }
  });

  test("verifyOtp accepts the issued code exactly once", async () => {
    const auth = makeAuth();
    try {
      const phone = "+14155552222";
      await auth.sendOtp(phone, "login", "sms");
      const code = requireLoginValue(
        requireLoginValue(MockSmsInbox.last(phone), "MockSmsInbox.last(phone)")
          .code,
        "MockSmsInbox.last(phone)!.code",
      );
      expect(await auth.verifyOtp(phone, code)).toEqual({ valid: true, phone });
      expect((await auth.verifyOtp(phone, code)).valid).toBe(false);
    } finally {
      auth.destroy();
    }
  });

  test("verifyOtp rejects mismatched phone (no cross-phone reuse)", async () => {
    const auth = makeAuth();
    try {
      const a = "+14155553333";
      const b = "+14155554444";
      await auth.sendOtp(a, "login", "sms");
      const code = requireLoginValue(
        requireLoginValue(MockSmsInbox.last(a), "MockSmsInbox.last(a)").code,
        "MockSmsInbox.last(a)!.code",
      );
      expect((await auth.verifyOtp(b, code)).valid).toBe(false);
      expect((await auth.verifyOtp(a, code)).valid).toBe(true);
    } finally {
      auth.destroy();
    }
  });

  test("verifyOtp rejects expired code", async () => {
    const auth = makeAuth({ tokenTtlMs: 10 });
    try {
      const phone = "+14155555555";
      await auth.sendOtp(phone, "login", "sms");
      const code = requireLoginValue(
        requireLoginValue(MockSmsInbox.last(phone), "MockSmsInbox.last(phone)")
          .code,
        "MockSmsInbox.last(phone)!.code",
      );
      await new Promise((r) => setTimeout(r, 30));
      expect((await auth.verifyOtp(phone, code)).valid).toBe(false);
    } finally {
      auth.destroy();
    }
  });

  test("sendOtp throws on non-E.164 phone", async () => {
    const auth = makeAuth();
    try {
      await expect(
        auth.sendOtp("4155551234", "login", "sms"),
      ).rejects.toThrow();
    } finally {
      auth.destroy();
    }
  });

  test("verifyOtp rejects non-numeric codes silently", async () => {
    const auth = makeAuth();
    try {
      const phone = "+14155556666";
      await auth.sendOtp(phone, "login", "sms");
      expect((await auth.verifyOtp(phone, "abcdef")).valid).toBe(false);
    } finally {
      auth.destroy();
    }
  });

  test("delegates code generation and checking to a managed provider", async () => {
    const provider = new ManagedProviderDouble();
    const auth = new PhoneAuth({ managedProvider: provider });
    try {
      const phone = "+14155557777";
      await auth.sendOtp(phone, "login:tenant-a", "sms");

      expect(provider.sends).toEqual([phone]);
      expect(await auth.verifyOtp(phone, "000000", "login:tenant-a")).toEqual({
        valid: false,
      });
      expect(await auth.verifyOtp(phone, "123456", "login:tenant-a")).toEqual({
        valid: true,
        phone,
      });
      expect(await auth.verifyOtp(phone, "123456", "login:tenant-a")).toEqual({
        valid: false,
      });
      expect(provider.checks).toHaveLength(2);
    } finally {
      auth.destroy();
    }
  });

  test("distinguishes a local preflight failure from an ambiguous provider outcome", async () => {
    const provider = new ManagedProviderDouble();
    const backend = new FaultingReservationBackend();
    const auth = new PhoneAuth({
      managedProvider: provider,
      tokenStore: new TokenStore({ backend }),
    });
    try {
      const phone = "+14155557778";
      await auth.sendOtp(phone, "login:tenant-a", "sms");

      backend.failReads = true;
      await expect(
        auth.verifyOtp(phone, "123456", "login:tenant-a"),
      ).rejects.toBeInstanceOf(SmsVerificationNotAttemptedError);
      expect(provider.checks).toEqual([]);

      backend.failReads = false;
      provider.rejectNextVerify = true;
      const ambiguous = await auth
        .verifyOtp(phone, "123456", "login:tenant-a")
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(ambiguous).toBeInstanceOf(SmsVerificationError);
      expect(ambiguous).not.toBeInstanceOf(SmsVerificationNotAttemptedError);
      expect(provider.checks).toHaveLength(1);
    } finally {
      auth.destroy();
    }
  });

  test("keeps the per-phone purpose fence shared across SMS and WhatsApp", async () => {
    const provider = new ManagedProviderDouble();
    const auth = new PhoneAuth({ managedProvider: provider });
    try {
      const phone = "+14155558888";
      await auth.sendOtp(phone, "login:tenant-a", "sms");
      await expect(
        auth.sendOtp(phone, "whatsapp:login:tenant-a", "whatsapp"),
      ).rejects.toThrow("already in progress");

      expect(provider.sendAttempts).toEqual([phone]);
      expect(provider.sendChannels).toEqual(["sms"]);
      expect(await auth.verifyOtp(phone, "123456", "login:tenant-a")).toEqual({
        valid: true,
        phone,
      });
    } finally {
      auth.destroy();
    }
  });

  test("allows same-purpose resends without extending the provider expiry", async () => {
    const provider = new ManagedProviderDouble();
    const auth = new PhoneAuth({ managedProvider: provider });
    try {
      const phone = "+14155559999";
      const first = await auth.sendOtp(phone, "login:tenant-a", "sms");
      setSystemTime(new Date(Date.now() + 60 * 1000));
      const resent = await auth.sendOtp(phone, "login:tenant-a", "sms");

      expect(provider.sends).toEqual([phone, phone]);
      expect(resent.expiresAt).toEqual(first.expiresAt);
      expect(await auth.verifyOtp(phone, "123456", "login:tenant-a")).toEqual({
        valid: true,
        phone,
      });
    } finally {
      auth.destroy();
    }
  });

  test("keeps another purpose blocked through provider validity after delayed acceptance", async () => {
    const provider = new ManagedProviderDouble();
    const auth = new PhoneAuth({
      managedProvider: provider,
      tokenTtlMs: 5 * 60 * 1000,
    });
    const startedAt = new Date("2026-08-26T12:00:00.000Z");
    setSystemTime(startedAt);
    provider.sendHook = async () => {
      setSystemTime(new Date(startedAt.getTime() + 20 * 1000));
    };
    try {
      const phone = "+14155559994";
      const { expiresAt } = await auth.sendOtp(phone, "login:tenant-a", "sms");
      expect(expiresAt.getTime()).toBe(
        startedAt.getTime() + 20 * 1000 + provider.challengeTtlMs,
      );

      setSystemTime(new Date(startedAt.getTime() + 5 * 60 * 1000 + 1));
      await expect(
        auth.sendOtp(phone, "mfa:enroll:user-a", "sms"),
      ).rejects.toThrow("already in progress");

      setSystemTime(new Date(expiresAt.getTime() - 1));
      await expect(
        auth.sendOtp(phone, "mfa:enroll:user-a", "sms"),
      ).rejects.toThrow("already in progress");
      expect(provider.sendAttempts).toEqual([phone]);

      provider.sendHook = undefined;
      setSystemTime(
        new Date(expiresAt.getTime() + provider.operationLockTtlMs + 1),
      );
      await auth.sendOtp(phone, "mfa:enroll:user-a", "sms");
      expect(provider.sendAttempts).toEqual([phone, phone]);
    } finally {
      auth.destroy();
    }
  });

  test("keeps the purpose fence through a bounded check window at provider expiry", async () => {
    const provider = new ManagedProviderDouble();
    const auth = new PhoneAuth({ managedProvider: provider });
    const startedAt = new Date("2026-08-26T13:00:00.000Z");
    setSystemTime(startedAt);
    try {
      const phone = "+14155559993";
      const { expiresAt } = await auth.sendOtp(phone, "login:tenant-a", "sms");
      setSystemTime(new Date(expiresAt.getTime() - 1));
      provider.verifyHook = async () => {
        setSystemTime(
          new Date(expiresAt.getTime() + provider.operationLockTtlMs - 3),
        );
      };

      await expect(
        auth.verifyOtp(phone, "000000", "login:tenant-a"),
      ).resolves.toEqual({
        valid: false,
      });
      await expect(
        auth.sendOtp(phone, "mfa:enroll:user-a", "sms"),
      ).rejects.toThrow("already in progress");
      expect(provider.sendAttempts).toEqual([phone]);

      provider.verifyHook = undefined;
      setSystemTime(
        new Date(expiresAt.getTime() + provider.operationLockTtlMs + 1),
      );
      await auth.sendOtp(phone, "mfa:enroll:user-a", "sms");
      expect(provider.sendAttempts).toEqual([phone, phone]);
    } finally {
      auth.destroy();
    }
  });

  test("keeps a failed send reserved so only the same purpose can retry", async () => {
    const provider = new ManagedProviderDouble();
    const auth = new PhoneAuth({ managedProvider: provider });
    try {
      const phone = "+14155559998";
      provider.rejectNextSend = true;

      await expect(
        auth.sendOtp(phone, "login:tenant-a", "sms"),
      ).rejects.toThrow("SMS delivery failed");
      await expect(
        auth.sendOtp(phone, "mfa:enroll:user-a", "sms"),
      ).rejects.toThrow("already in progress");
      await auth.sendOtp(phone, "login:tenant-a", "sms");

      expect(provider.sendAttempts).toEqual([phone, phone]);
      expect(await auth.verifyOtp(phone, "123456", "login:tenant-a")).toEqual({
        valid: true,
        phone,
      });
    } finally {
      auth.destroy();
    }
  });

  test("reserves before delivery so concurrent purposes cannot reorder the binding", async () => {
    const provider = new ManagedProviderDouble();
    let markSendStarted!: () => void;
    let releaseSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    provider.sendHook = async () => {
      markSendStarted();
      await sendGate;
    };
    const auth = new PhoneAuth({ managedProvider: provider });
    try {
      const phone = "+14155559997";
      const loginSend = auth.sendOtp(phone, "login:tenant-a", "sms");
      await sendStarted;

      await expect(
        auth.sendOtp(phone, "mfa:enroll:user-a", "sms"),
      ).rejects.toThrow("already in progress");
      expect(provider.sendAttempts).toEqual([phone]);

      releaseSend();
      await loginSend;
      expect(await auth.verifyOtp(phone, "123456", "login:tenant-a")).toEqual({
        valid: true,
        phone,
      });
    } finally {
      releaseSend();
      auth.destroy();
    }
  });

  test("renews the exact operation lease after slow reservation storage", async () => {
    const provider = new ManagedProviderDouble();
    const backend = new LeaseExpiringBeforeProviderBackend();
    const auth = new PhoneAuth({
      managedProvider: provider,
      tokenStore: new TokenStore({ backend }),
    });
    try {
      await expect(
        auth.sendOtp("+14155559991", "login:tenant-a", "sms"),
      ).rejects.toThrow("SMS delivery failed");
      expect(provider.sendAttempts).toEqual([]);
    } finally {
      auth.destroy();
    }
  });

  test("does not call the provider when a same-purpose reservation update fails", async () => {
    const provider = new ManagedProviderDouble();
    const backend = new FaultingReservationBackend();
    const auth = new PhoneAuth({
      managedProvider: provider,
      tokenStore: new TokenStore({ backend }),
    });
    try {
      const phone = "+14155559996";
      await auth.sendOtp(phone, "login:tenant-a", "sms");
      backend.failTransitions = true;

      await expect(
        auth.sendOtp(phone, "login:tenant-a", "sms"),
      ).rejects.toThrow("SMS delivery failed");
      expect(provider.sendAttempts).toEqual([phone]);
    } finally {
      auth.destroy();
    }
  });

  test("keeps a provider-accepted challenge purpose-bound after active publication fails", async () => {
    const provider = new ManagedProviderDouble();
    const backend = new FaultingReservationBackend();
    const auth = new PhoneAuth({
      managedProvider: provider,
      tokenStore: new TokenStore({ backend }),
    });
    try {
      const phone = "+14155559992";
      backend.failActivePublication = true;
      await expect(
        auth.sendOtp(phone, "login:tenant-a", "sms"),
      ).rejects.toThrow("SMS delivery failed");

      await expect(
        auth.sendOtp(phone, "mfa:enroll:user-a", "sms"),
      ).rejects.toThrow("already in progress");
      expect(provider.sendAttempts).toEqual([phone]);

      backend.failActivePublication = false;
      const resent = await auth.sendOtp(phone, "login:tenant-a", "sms");
      expect(resent.expiresAt.getTime()).toBe(provider.challengeExpiresAt);
      expect(provider.sendAttempts).toEqual([phone, phone]);
      expect(await auth.verifyOtp(phone, "123456", "login:tenant-a")).toEqual({
        valid: true,
        phone,
      });
    } finally {
      auth.destroy();
    }
  });

  test("blocks a resend and overlapping verifier while a managed check is in flight", async () => {
    const provider = new ManagedProviderDouble();
    let releaseCheck!: () => void;
    let markCheckStarted!: () => void;
    const checkStarted = new Promise<void>((resolve) => {
      markCheckStarted = resolve;
    });
    const checkGate = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    provider.verifyHook = async () => {
      markCheckStarted();
      await checkGate;
    };
    const auth = new PhoneAuth({ managedProvider: provider });
    try {
      const phone = "+14155559995";
      await auth.sendOtp(phone, "login:tenant-a", "sms");
      const firstCheck = auth.verifyOtp(phone, "123456", "login:tenant-a");
      await checkStarted;

      await expect(
        auth.sendOtp(phone, "login:tenant-a", "sms"),
      ).rejects.toThrow("already in progress");
      await expect(
        auth.verifyOtp(phone, "123456", "login:tenant-a"),
      ).rejects.toThrow("already in progress");
      expect(provider.sendAttempts).toEqual([phone]);
      expect(provider.checks).toHaveLength(1);

      releaseCheck();
      await expect(firstCheck).resolves.toEqual({ valid: true, phone });
    } finally {
      releaseCheck();
      auth.destroy();
    }
  });

  test("rejects an approved check when its exact operation lease expired before release", async () => {
    const provider = new ManagedProviderDouble();
    const auth = new PhoneAuth({ managedProvider: provider });
    const startedAt = new Date("2026-08-26T14:00:00.000Z");
    setSystemTime(startedAt);
    try {
      const phone = "+14155559990";
      await auth.sendOtp(phone, "login:tenant-a", "sms");
      provider.verifyHook = async () => {
        setSystemTime(new Date(Date.now() + provider.operationLockTtlMs + 1));
      };

      const staleApproval = await auth
        .verifyOtp(phone, "123456", "login:tenant-a")
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(staleApproval).toBeInstanceOf(SmsVerificationError);
      expect(staleApproval).not.toBeInstanceOf(
        SmsVerificationNotAttemptedError,
      );
    } finally {
      auth.destroy();
    }
  });

  test("rejects ambiguous local and managed provider configuration", () => {
    expect(
      () =>
        new PhoneAuth({
          provider: new MockSmsProvider(),
          managedProvider: new ManagedProviderDouble(),
        }),
    ).toThrow("either provider or managedProvider");
  });
});
