/**
 * PhoneAuth — SMS OTP login.
 *
 * 6-digit numeric code, persisted as hash-of-(phone||code) so a leaked code
 * cannot be replayed against a different phone number. One-time consume,
 * 5-minute TTL by default.
 *
 * Caller responsibilities at the API layer:
 *  - Rate-limit /sendOtp per phone number and per IP.
 *  - Track failed verifyOtp attempts and lock out after N (e.g. 5).
 */

import { randomBytes, randomInt } from "node:crypto";
import { requireLoginValue } from "../../../required";

import { hashSha256Hex } from "./crypto";
import {
  ConsoleSmsProvider,
  type ManagedOtpDeliveryChannel,
  type ManagedSmsOtpProvider,
  SmsDeliveryError,
  type SmsProvider,
  SmsVerificationError,
  SmsVerificationNotAttemptedError,
} from "./sms-provider";
import { TokenStore } from "./token-store";

export interface PhoneAuthConfig {
  provider?: SmsProvider;
  /** Provider-managed code generation and verification (for example Twilio Verify). */
  managedProvider?: ManagedSmsOtpProvider;
  /** Local OTP TTL. Managed challenges never expire before their provider. */
  tokenTtlMs?: number;
  tokenStore?: TokenStore;
  bodyTemplate?: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_BODY =
  "Your code is {code}. Expires in 5 minutes. Do not share it.";
const E164 = /^\+[1-9]\d{6,14}$/;

function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function codeStorageKey(phone: string, code: string, purpose: string): string {
  return hashSha256Hex(`${purpose}:${phone}:${code}`);
}

function managedChallengeStorageKey(phone: string): string {
  // One active managed challenge per phone prevents a provider-owned code from
  // crossing Steward's login, MFA, enrollment, and account-link purposes.
  return hashSha256Hex(`managed-phone-otp:${phone}`);
}

function managedOperationStorageKey(phone: string): string {
  return hashSha256Hex(`managed-phone-otp-operation:${phone}`);
}

type ManagedChallengeReservation = {
  version: 2;
  purposeHash: string;
  nonce: string;
  challengeExpiresAt: number | null;
};

function managedPurposeHash(purpose: string): string {
  return hashSha256Hex(`managed-phone-otp-purpose:${purpose}`);
}

function newManagedChallengeReservation(
  purpose: string,
  challengeExpiresAt: number | null,
): string {
  return JSON.stringify({
    version: 2,
    purposeHash: managedPurposeHash(purpose),
    nonce: randomBytes(16).toString("hex"),
    challengeExpiresAt,
  } satisfies ManagedChallengeReservation);
}

function parseManagedChallengeReservation(
  value: string | null,
): ManagedChallengeReservation | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ManagedChallengeReservation>;
    if (
      parsed.version !== 2 ||
      typeof parsed.purposeHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(parsed.purposeHash) ||
      typeof parsed.nonce !== "string" ||
      !/^[0-9a-f]{32}$/.test(parsed.nonce) ||
      (parsed.challengeExpiresAt !== null &&
        (typeof parsed.challengeExpiresAt !== "number" ||
          !Number.isSafeInteger(parsed.challengeExpiresAt) ||
          parsed.challengeExpiresAt <= 0))
    ) {
      return null;
    }
    return parsed as ManagedChallengeReservation;
  } catch {
    return null;
  }
}

/** A different auth flow already owns the active managed OTP for this phone. */
export class SmsChallengeInProgressError extends Error {
  constructor() {
    super("An SMS verification is already in progress");
    this.name = "SmsChallengeInProgressError";
  }
}

export function isValidE164(phone: unknown): phone is string {
  return typeof phone === "string" && E164.test(phone);
}

export class PhoneAuth {
  private provider?: SmsProvider;
  private managedProvider?: ManagedSmsOtpProvider;
  private tokenStore: TokenStore;
  private tokenTtlMs: number;
  private managedOperationLockTtlMs: number;
  private managedReservationTtlMs: number;
  private bodyTemplate: string;

  constructor(config: PhoneAuthConfig = {}) {
    if (config.provider && config.managedProvider) {
      throw new Error(
        "PhoneAuth accepts either provider or managedProvider, not both",
      );
    }
    this.managedProvider = config.managedProvider;
    this.provider =
      config.provider ??
      (config.managedProvider ? undefined : new ConsoleSmsProvider());
    this.tokenStore = config.tokenStore ?? new TokenStore();
    this.tokenTtlMs = config.tokenTtlMs ?? DEFAULT_TTL_MS;
    if (
      config.managedProvider &&
      (!Number.isFinite(config.managedProvider.challengeTtlMs) ||
        config.managedProvider.challengeTtlMs <= 0 ||
        !Number.isFinite(config.managedProvider.operationLockTtlMs) ||
        config.managedProvider.operationLockTtlMs <= 0 ||
        !Number.isFinite(config.managedProvider.reservationTtlMs) ||
        config.managedProvider.reservationTtlMs <= 0)
    ) {
      throw new Error("managed provider TTLs must be positive finite numbers");
    }
    if (
      config.managedProvider &&
      config.managedProvider.reservationTtlMs <
        config.managedProvider.challengeTtlMs +
          2 * config.managedProvider.operationLockTtlMs
    ) {
      throw new Error(
        "managed provider reservation TTL must cover send and verify windows",
      );
    }
    this.managedOperationLockTtlMs =
      config.managedProvider?.operationLockTtlMs ?? this.tokenTtlMs;
    this.managedReservationTtlMs =
      config.managedProvider?.reservationTtlMs ?? this.tokenTtlMs;
    this.bodyTemplate = config.bodyTemplate ?? DEFAULT_BODY;
  }

  private managedOperationError(
    kind: "send" | "verify",
    error?: unknown,
    providerAttempted = false,
  ): Error {
    if (error instanceof SmsChallengeInProgressError) return error;
    if (kind === "send" && error instanceof SmsDeliveryError) return error;
    if (kind === "verify" && error instanceof SmsVerificationError)
      return error;
    if (kind === "send") return new SmsDeliveryError();
    return providerAttempted
      ? new SmsVerificationError()
      : new SmsVerificationNotAttemptedError();
  }

  private async acquireManagedOperation(
    phone: string,
    kind: "send" | "verify",
  ): Promise<{ key: string; token: string }> {
    const key = managedOperationStorageKey(phone);
    const token = `managed-phone-otp-operation:${randomBytes(16).toString("hex")}`;
    let acquired: boolean;
    try {
      acquired = await this.tokenStore.setIfNotExists(
        key,
        token,
        this.managedOperationLockTtlMs,
      );
    } catch (error) {
      throw this.managedOperationError(kind, error, false);
    }
    if (!acquired) throw new SmsChallengeInProgressError();
    return { key, token };
  }

  private async releaseManagedOperation(lock: {
    key: string;
    token: string;
  }): Promise<boolean> {
    // Atomic non-idempotent exact-token delete: absence is false, and an
    // expired lease that has been reacquired can never be removed by its older
    // owner (including the absent-key ABA case).
    return this.tokenStore.compareDelete(lock.key, lock.token);
  }

  private async renewManagedOperation(
    lock: { key: string; token: string },
    kind: "send" | "verify",
  ): Promise<void> {
    let renewed: boolean;
    try {
      renewed = await this.tokenStore.transition(
        lock.key,
        lock.token,
        lock.token,
        this.managedOperationLockTtlMs,
      );
    } catch (error) {
      throw this.managedOperationError(kind, error, false);
    }
    if (!renewed) throw new SmsChallengeInProgressError();
  }

  private async withManagedOperation<T>(
    phone: string,
    kind: "send" | "verify",
    operation: (
      lock: { key: string; token: string },
      markProviderAttempted: () => void,
    ) => Promise<T>,
  ): Promise<T> {
    const lock = await this.acquireManagedOperation(phone, kind);
    let providerAttempted = false;
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = {
        ok: true,
        value: await operation(lock, () => {
          providerAttempted = true;
        }),
      };
    } catch (error) {
      outcome = { ok: false, error };
    }

    let released = false;
    try {
      released = await this.releaseManagedOperation(lock);
    } catch {
      // A lost exact release remains fail-closed until the bounded lock TTL.
    }
    if (!released)
      throw this.managedOperationError(kind, undefined, providerAttempted);
    if (!outcome.ok) {
      throw this.managedOperationError(kind, outcome.error, providerAttempted);
    }
    return outcome.value;
  }

  private async reserveManagedChallenge(
    phone: string,
    purpose: string,
  ): Promise<string> {
    const key = managedChallengeStorageKey(phone);
    const purposeHash = managedPurposeHash(purpose);

    // setIfNotExists is the initial per-phone ownership boundary. A same-purpose
    // resend atomically rotates the reservation while preserving any active
    // provider expiry; a different purpose cannot deliver a competing code.
    for (let attempt = 0; attempt < 3; attempt++) {
      const initial = newManagedChallengeReservation(purpose, null);
      if (
        await this.tokenStore.setIfNotExists(
          key,
          initial,
          this.managedReservationTtlMs,
        )
      ) {
        return initial;
      }

      const current = await this.tokenStore.verify(key);
      const reservation = parseManagedChallengeReservation(current);
      if (!current || !reservation) continue;
      if (reservation.purposeHash !== purposeHash)
        throw new SmsChallengeInProgressError();
      const desired = newManagedChallengeReservation(
        purpose,
        reservation.challengeExpiresAt,
      );
      if (
        await this.tokenStore.transition(
          key,
          current,
          desired,
          this.managedReservationTtlMs,
        )
      ) {
        return desired;
      }
    }

    // Repeated concurrent changes are treated as a conflict. No SMS has been
    // sent, so callers can safely retry after the active reservation expires.
    throw new SmsChallengeInProgressError();
  }

  private async finalizeManagedChallenge(
    phone: string,
    purpose: string,
    reserved: string,
    expiresAt: Date,
  ): Promise<void> {
    const expiresAtMs = expiresAt.getTime();
    const now = Date.now();
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now) {
      throw new SmsDeliveryError();
    }
    const active = newManagedChallengeReservation(purpose, expiresAtMs);
    // A check may begin immediately before provider expiry. Keep the binding
    // through its bounded operation-lock window so the exact-generation claim
    // can finish without opening a cross-purpose gap.
    const activeTtlMs = expiresAtMs - now + this.managedOperationLockTtlMs;
    if (
      !(await this.tokenStore.transition(
        managedChallengeStorageKey(phone),
        reserved,
        active,
        activeTtlMs,
      ))
    ) {
      throw new SmsDeliveryError();
    }
  }

  async sendOtp(
    phone: string,
    purpose: string,
    deliveryChannel: ManagedOtpDeliveryChannel,
  ): Promise<{ expiresAt: Date }> {
    if (!isValidE164(phone)) {
      throw new Error("phone must be E.164 (e.g. +14155551234)");
    }
    if (this.managedProvider) {
      return this.withManagedOperation(
        phone,
        "send",
        async (lock, markProviderAttempted) => {
          // Purpose-bind before external delivery. The conservative reservation
          // remains on any provider or publication failure: other purposes fail
          // closed, while the same purpose may safely retry after this operation.
          const reserved = await this.reserveManagedChallenge(phone, purpose);
          // Local reservation storage can be slower than the original lease.
          // Rebase the exact-token lock immediately before the bounded provider
          // request; a lost lease fails before any remote side effect.
          await this.renewManagedOperation(lock, "send");
          markProviderAttempted();
          const delivery = await requireLoginValue(
            this.managedProvider,
            "this.managedProvider",
          ).send(phone, deliveryChannel);
          await this.finalizeManagedChallenge(
            phone,
            purpose,
            reserved,
            delivery.expiresAt,
          );
          return delivery;
        },
      );
    }

    const supportedChannels =
      this.provider?.otpDeliveryChannels ?? (["sms"] as const);
    if (!supportedChannels.includes(deliveryChannel))
      throw new SmsDeliveryError();

    const expiresAt = new Date(Date.now() + this.tokenTtlMs);
    const code = generateCode();
    const key = codeStorageKey(phone, code, purpose);
    await this.tokenStore.store(key, phone, this.tokenTtlMs);
    await requireLoginValue(this.provider, "this.provider").send(
      phone,
      this.bodyTemplate.replace("{code}", code),
    );
    return { expiresAt };
  }

  async verifyOtp(
    phone: string,
    code: string,
    purpose = "login",
  ): Promise<{ valid: boolean; phone?: string }> {
    if (!isValidE164(phone) || !/^\d{6}$/.test(code)) {
      return { valid: false };
    }

    if (this.managedProvider) {
      return this.withManagedOperation(
        phone,
        "verify",
        async (lock, markProviderAttempted) => {
          const key = managedChallengeStorageKey(phone);
          const serializedReservation = await this.tokenStore.verify(key);
          const reservation = parseManagedChallengeReservation(
            serializedReservation,
          );
          if (
            !serializedReservation ||
            reservation?.purposeHash !== managedPurposeHash(purpose) ||
            reservation.challengeExpiresAt === null ||
            reservation.challengeExpiresAt <= Date.now()
          ) {
            return { valid: false };
          }
          await this.renewManagedOperation(lock, "verify");
          markProviderAttempted();
          if (
            !(await requireLoginValue(
              this.managedProvider,
              "this.managedProvider",
            ).verify(phone, code))
          )
            return { valid: false };

          // Provider approval consumes the remote challenge. Claim and consume
          // this exact local generation while the per-phone operation lock still
          // excludes every resend and competing verifier.
          const claimed = `managed-phone-otp-claimed:${randomBytes(16).toString("hex")}`;
          if (
            !(await this.tokenStore.transition(
              key,
              serializedReservation,
              claimed,
              this.managedOperationLockTtlMs,
            ))
          ) {
            return { valid: false };
          }
          if ((await this.tokenStore.consume(key)) !== claimed)
            return { valid: false };
          return { valid: true, phone };
        },
      );
    }

    const key = codeStorageKey(phone, code, purpose);
    const stored = await this.tokenStore.consume(key);
    if (!stored || stored !== phone) {
      return { valid: false };
    }
    return { valid: true, phone };
  }

  destroy(): void {
    this.tokenStore.destroy();
  }
}
