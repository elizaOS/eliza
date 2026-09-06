/** Delivers login challenges and invitations with one-time grant storage and explicit delivery failures. */
import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { logger } from "@elizaos/logger";
import { redactedThrownDiagnostics } from "../../shared/src/index.ts";

import { hashSha256Hex } from "./crypto";
import type { EmailDeliveryReceipt, EmailProvider } from "./email-provider";
import {
  ConsoleProvider,
  EmailDeliveryError,
  EmailDeliveryNotConfiguredError,
} from "./email-provider";
import {
  renderOtpTemplate as defaultOtpTemplateRenderer,
  renderTemplate as defaultTemplateRenderer,
  type MagicLinkTemplateData,
  type OtpTemplateData,
  type RenderedMagicLinkTemplate,
} from "./email-templates";
import { isDevSecretAllowed } from "./jwt";
import type { StorePublishEntry } from "./store-backends";
import { TokenStore } from "./token-store";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface EmailAuthConfig {
  /** Sender address, e.g. "login@eliza.app" */
  from: string;
  /** Base URL for building the callback link, e.g. "https://eliza.app" */
  baseUrl: string;
  /**
   * Pluggable email provider.
   * Defaults to ConsoleProvider so nothing breaks without API credentials.
   */
  provider?: EmailProvider;
  /** Token TTL in milliseconds. Default: 10 minutes. */
  tokenTtlMs?: number;
  /** Maximum time to wait for a provider acceptance receipt. Default: 30 seconds. */
  deliveryTimeoutMs?: number;
  /** Path that receives the magic-link callback. Default: "/auth/callback/email" */
  callbackPath?: string;
  /**
   * Optional external TokenStore to use for magic-link tokens.
   * Defaults to a fresh TokenStore backed by in-memory storage.
   * Pass a store configured with a Redis or Postgres backend for
   * restart-safe / multi-instance deployments.
   */
  tokenStore?: TokenStore;
  /** Override the magic-link template renderer. */
  templateRenderer?: (
    templateId: string | undefined,
    data: MagicLinkTemplateData,
  ) => RenderedMagicLinkTemplate;
  /** Override the OTP (sign-in code) template renderer. */
  otpTemplateRenderer?: (
    templateId: string | undefined,
    data: OtpTemplateData,
  ) => RenderedMagicLinkTemplate;
  /** Template ID to render for outgoing magic-link emails. */
  templateId?: string;
  /** Display brand used by the built-in magic-link and OTP templates. */
  brandName?: string;
  /** Override the rendered subject line. */
  subjectOverride?: string;
  /** Optional reply-to address to pass through to the provider. */
  replyTo?: string;
  /** Server secret used for keyed email login code and polling verifiers. */
  codeVerifierSecret?: string;
}

export interface TenantInvitationEmailContext {
  tenantId: string;
  token: string;
  expiresAt: Date;
  acceptPath?: string;
  tenantName?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN_BYTES = 32;
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_CALLBACK = "/auth/callback/email";
const OTP_DIGITS = 6;
const EMAIL_LOGIN_PURPOSE = "email-login";
const MAX_EMAIL_LOGIN_CODE_ATTEMPTS = 5;
const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000;
const MAX_DELIVERY_TIMEOUT_MS = 5 * 60_000;

function generateToken(): string {
  // URL-safe hex token (64 chars from 32 bytes)
  return randomBytes(TOKEN_BYTES).toString("hex");
}

function generateOpaqueId(): string {
  return randomBytes(32).toString("hex");
}

function generateOtpCode(): string {
  // randomInt uses rejection sampling internally and avoids modulo bias.
  return String(randomInt(10 ** OTP_DIGITS)).padStart(OTP_DIGITS, "0");
}

function hashToken(token: string): string {
  return hashSha256Hex(token);
}

function keyedHash(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function buildMagicLink(
  baseUrl: string,
  callbackPath: string,
  token: string,
  email: string,
  tenantId?: string,
): string {
  const url = new URL(callbackPath, baseUrl);
  url.searchParams.set("token", token);
  url.searchParams.set("email", email);
  // Carry the tenant so GET /auth/callback/email resolves the SAME tenant the
  // token was minted for (mirrors buildInvitationLink). Without it the callback
  // falls back to the default tenant, the verify tenant guard fires
  // tenant_mismatch, and the issued exchange-code is stored with the wrong
  // tenant -> the SPA's /oauth/exchange then 401s code_tenant_mismatch.
  if (tenantId) url.searchParams.set("tenantId", tenantId);
  return url.toString();
}

function buildInvitationLink(
  baseUrl: string,
  acceptPath: string,
  token: string,
  tenantId: string,
  email: string,
): string {
  const url = new URL(acceptPath, baseUrl);
  url.searchParams.set("tenantId", tenantId);
  url.searchParams.set("token", token);
  url.searchParams.set("email", email);
  return url.toString();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type MagicLinkPayload = {
  email: string;
  tenantId?: string;
};

type EmailLoginChallengeRecord = {
  status: "delivery_pending" | "active" | "pending";
  challengeId: string;
  emailHash: string;
  tenantId?: string;
  purpose: typeof EMAIL_LOGIN_PURPOSE;
  codeVerifier: string;
  pollSecretHash: string;
  expiresAt: string;
};

type EmailLoginStatusRecord = {
  status: "delivery_pending" | "pending" | "consumed" | "locked";
  challengeId: string;
  pollSecretHash: string;
  expiresAt: string;
};

export type EmailLoginVerifyResult =
  | { valid: true; email: string; tenantId?: string; challengeId: string }
  | { valid: false; email: ""; reason?: "invalid" | "locked" };

export type EmailLoginChallengeStatus =
  | { status: "pending"; expiresAt: string }
  | { status: "consumed" | "locked" | "expired" | "invalid" };

function otpStoreKey(
  email: string,
  tenantId: string | undefined,
  code: string,
): string {
  // Hash binds the code to {email, tenant} so a code minted for one address
  // or tenant can never verify for another.
  return hashSha256Hex(`email-otp:${tenantId ?? ""}:${email}:${code}`);
}

function otpTargetKey(email: string, tenantId: string | undefined): string {
  return `email-otp:active:${hashSha256Hex(`${tenantId ?? ""}:${email}`)}`;
}

function emailLoginBinding(
  email: string,
  tenantId: string | undefined,
): string {
  return `${tenantId ?? ""}:${email}:${EMAIL_LOGIN_PURPOSE}`;
}

function emailLoginTargetKey(
  email: string,
  tenantId: string | undefined,
): string {
  return `email-login:active:${hashSha256Hex(emailLoginBinding(email, tenantId))}`;
}

function emailLoginChallengeKey(challengeId: string): string {
  // Keep the established durable key prefix for rolling-deploy compatibility.
  return `email-login:pending:${challengeId}`;
}

function emailLoginStagingKey(challengeId: string): string {
  return `email-login:staged:${challengeId}`;
}

function emailLoginStatusKey(challengeId: string): string {
  return `email-login:status:${challengeId}`;
}

function emailLoginLinkAliasKey(tokenHash: string): string {
  return `email-login:link:${tokenHash}`;
}

function emailLoginCodeAliasKey(codeVerifier: string): string {
  return `email-login:code:${codeVerifier}`;
}

function emailLoginFailureKey(challengeId: string, slot: number): string {
  return `email-login:failure:${challengeId}:${slot}`;
}

function otpStagingKey(challengeId: string): string {
  return `email-otp:staged:${challengeId}`;
}

function issuanceReservationKey(targetKey: string): string {
  return `email-issuance:reservation:${hashSha256Hex(targetKey)}`;
}

interface IssuanceReservation {
  kind: "email-issuance-reservation";
  id: string;
  prior: string | null;
}

function encodeIssuanceReservation(id: string, prior: string | null): string {
  return JSON.stringify({
    kind: "email-issuance-reservation",
    id,
    prior,
  } satisfies IssuanceReservation);
}

function issuancePublicationMarker(reservation: string): string {
  return `published:${hashSha256Hex(reservation)}`;
}

function issuancePublicationReceiptKey(reservation: string): string {
  return `email-issuance:published:${hashSha256Hex(reservation)}`;
}

function parseIssuanceReservation(
  value: string | null,
): IssuanceReservation | null {
  if (!value?.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value) as Partial<IssuanceReservation>;
    if (
      parsed.kind === "email-issuance-reservation" &&
      typeof parsed.id === "string" &&
      (typeof parsed.prior === "string" || parsed.prior === null)
    ) {
      return parsed as IssuanceReservation;
    }
  } catch {
    // Legacy target values are opaque identifiers, not JSON.
  }
  return null;
}

function parseEmailLoginChallenge(
  value: string | null,
): EmailLoginChallengeRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Omit<
      Partial<EmailLoginChallengeRecord>,
      "status"
    > & {
      status?: string;
    };
    if (
      (parsed.status === "delivery_pending" ||
        parsed.status === "active" ||
        parsed.status === "pending") &&
      typeof parsed.challengeId === "string" &&
      typeof parsed.emailHash === "string" &&
      parsed.purpose === EMAIL_LOGIN_PURPOSE &&
      typeof parsed.codeVerifier === "string" &&
      typeof parsed.pollSecretHash === "string" &&
      typeof parsed.expiresAt === "string"
    ) {
      return {
        ...(parsed as EmailLoginChallengeRecord),
        status: parsed.status === "pending" ? "active" : parsed.status,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function parseStatusRecord(
  value: string | null,
): EmailLoginStatusRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<EmailLoginStatusRecord>;
    if (
      typeof parsed.challengeId === "string" &&
      typeof parsed.pollSecretHash === "string" &&
      typeof parsed.expiresAt === "string" &&
      (parsed.status === "delivery_pending" ||
        parsed.status === "pending" ||
        parsed.status === "consumed" ||
        parsed.status === "locked")
    ) {
      return parsed as EmailLoginStatusRecord;
    }
  } catch {
    return null;
  }
  return null;
}

function decodeMagicLinkPayload(value: string): MagicLinkPayload {
  try {
    const parsed = JSON.parse(value) as MagicLinkPayload;
    if (typeof parsed.email === "string") return parsed;
  } catch {
    // Backward-compatible legacy tokens stored the email as the raw value.
  }
  return { email: value };
}

function decodeLegacyOtpPayload(value: string): MagicLinkPayload | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.email === "string" &&
      (parsed.tenantId === undefined || typeof parsed.tenantId === "string") &&
      Object.keys(parsed).every((key) => key === "email" || key === "tenantId")
    ) {
      return parsed as MagicLinkPayload;
    }
  } catch {
    // The earliest OTP records stored the email directly.
    return value.startsWith("{") ? null : { email: value };
  }
  return null;
}

type OtpChallengeRecord =
  | { status: "delivery_pending" }
  | {
      status: "active";
      payload: MagicLinkPayload;
      email?: string;
      tenantId?: string;
    };

const MAX_EMAIL_RECEIPT_PROVIDER_LENGTH = 64;
const MAX_EMAIL_RECEIPT_ID_LENGTH = 512;

function boundedReceiptText(
  value: unknown,
  maxLength: number,
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  )
    return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return value.trim().length > 0;
}

function isValidDeliveryReceipt(value: unknown): value is EmailDeliveryReceipt {
  if (!value || typeof value !== "object") return false;
  try {
    const provider = Object.getOwnPropertyDescriptor(value, "provider");
    if (
      !provider ||
      !("value" in provider) ||
      !boundedReceiptText(provider.value, MAX_EMAIL_RECEIPT_PROVIDER_LENGTH)
    ) {
      return false;
    }
    const id = Object.getOwnPropertyDescriptor(value, "id");
    return (
      id === undefined ||
      ("value" in id &&
        boundedReceiptText(id.value, MAX_EMAIL_RECEIPT_ID_LENGTH))
    );
  } catch {
    return false;
  }
}

function encodeOtpChallenge(
  status: OtpChallengeRecord["status"],
  payload?: MagicLinkPayload,
): string {
  if (status === "delivery_pending")
    return JSON.stringify({ status } satisfies OtpChallengeRecord);
  if (!payload) throw new Error("Active OTP challenge requires a payload");
  // Retain support for the short-lived active wrapper emitted after staged
  // delivery first shipped. New writes use the older raw payload below so
  // every pod in a rolling deployment can redeem an accepted code.
  return JSON.stringify({
    status,
    payload,
    ...payload,
  } satisfies OtpChallengeRecord);
}

function decodeOtpChallenge(value: string | null): OtpChallengeRecord | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const record = parsed as Record<string, unknown>;
    const payload = record.payload;
    if (record.status === "delivery_pending")
      return { status: "delivery_pending" };
    if (
      record.status === "active" &&
      payload &&
      typeof payload === "object" &&
      "email" in payload &&
      typeof payload.email === "string" &&
      (("tenantId" in payload ? payload.tenantId : undefined) === undefined ||
        typeof ("tenantId" in payload ? payload.tenantId : undefined) ===
          "string") &&
      (record.email === undefined || record.email === payload.email) &&
      (record.tenantId === undefined ||
        record.tenantId ===
          ("tenantId" in payload ? payload.tenantId : undefined))
    ) {
      return parsed as OtpChallengeRecord;
    }
  } catch {
    // error-policy:J3 malformed stored OTP data is explicitly invalid.
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// EmailAuth
// ---------------------------------------------------------------------------

export class EmailAuth {
  private provider: EmailProvider;
  private deliveryNotConfigured: boolean;
  private tokenStore: TokenStore;
  private baseUrl: string;
  private callbackPath: string;
  private tokenTtlMs: number;
  private deliveryTimeoutMs: number;
  private from: string;
  private replyTo?: string;
  private templateId?: string;
  private brandName?: string;
  private subjectOverride?: string;
  private codeVerifierSecret: string;
  private templateRenderer: (
    templateId: string | undefined,
    data: MagicLinkTemplateData,
  ) => RenderedMagicLinkTemplate;
  private otpTemplateRenderer: (
    templateId: string | undefined,
    data: OtpTemplateData,
  ) => RenderedMagicLinkTemplate;

  constructor(config: EmailAuthConfig) {
    this.from = config.from;
    this.baseUrl = config.baseUrl.replace(/\/$/, ""); // strip trailing slash
    this.callbackPath = config.callbackPath ?? DEFAULT_CALLBACK;
    this.tokenTtlMs = config.tokenTtlMs ?? DEFAULT_TTL_MS;
    this.deliveryTimeoutMs =
      config.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.deliveryTimeoutMs) ||
      this.deliveryTimeoutMs <= 0 ||
      this.deliveryTimeoutMs > MAX_DELIVERY_TIMEOUT_MS
    ) {
      throw new Error(
        `deliveryTimeoutMs must be an integer between 1 and ${MAX_DELIVERY_TIMEOUT_MS}`,
      );
    }
    this.provider = config.provider ?? new ConsoleProvider();
    // Console delivery is forbidden in production. Reject before storing a
    // challenge so the API cannot report success for an undeliverable login.
    this.deliveryNotConfigured =
      process.env.NODE_ENV === "production" &&
      this.provider instanceof ConsoleProvider;
    this.tokenStore = config.tokenStore ?? new TokenStore();
    this.replyTo = config.replyTo;
    this.templateId = config.templateId;
    this.brandName = config.brandName?.trim() || undefined;
    this.subjectOverride = config.subjectOverride;
    const configuredCodeSecret =
      config.codeVerifierSecret?.trim() ||
      process.env.STEWARD_EMAIL_CODE_SECRET?.trim() ||
      "";
    if (!configuredCodeSecret) {
      // Tests intentionally use an isolated deterministic fallback. Every
      // runnable non-test environment must explicitly opt in to that fallback,
      // matching the repository-wide dev-secret policy.
      if (process.env.NODE_ENV !== "test" && !isDevSecretAllowed()) {
        throw new Error(
          "STEWARD_EMAIL_CODE_SECRET is required. For local development only, set STEWARD_ALLOW_DEV_SECRETS=true to use the insecure dev secret.",
        );
      }
    } else if (
      process.env.NODE_ENV === "production" &&
      configuredCodeSecret.length < 32
    ) {
      throw new Error(
        "STEWARD_EMAIL_CODE_SECRET must be at least 32 characters in production",
      );
    }
    this.codeVerifierSecret =
      configuredCodeSecret || "steward-development-email-login-secret";
    this.templateRenderer = config.templateRenderer ?? defaultTemplateRenderer;
    this.otpTemplateRenderer =
      config.otpTemplateRenderer ?? defaultOtpTemplateRenderer;
  }

  private emailHash(email: string, tenantId: string | undefined): string {
    return keyedHash(
      this.codeVerifierSecret,
      emailLoginBinding(email, tenantId),
    );
  }

  private codeVerifier(
    email: string,
    tenantId: string | undefined,
    code: string,
  ): string {
    return keyedHash(
      this.codeVerifierSecret,
      `${emailLoginBinding(email, tenantId)}:${code}`,
    );
  }

  private pollSecretHash(challengeId: string, pollSecret: string): string {
    return keyedHash(
      this.codeVerifierSecret,
      `${challengeId}:${pollSecret}:poll`,
    );
  }

  private pollSecretMatches(
    challengeId: string,
    pollSecret: string,
    expected: string,
  ): boolean {
    const actual = Buffer.from(
      this.pollSecretHash(challengeId, pollSecret),
      "hex",
    );
    const stored = Buffer.from(expected, "hex");
    return actual.length === stored.length && timingSafeEqual(actual, stored);
  }

  private assertDeliveryConfigured(): void {
    if (this.deliveryNotConfigured) {
      throw new EmailDeliveryNotConfiguredError();
    }
  }

  /** Dispatch through the provider and require a redacted acceptance receipt. */
  private async sendAccepted(message: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<EmailDeliveryReceipt> {
    let receipt: EmailDeliveryReceipt | undefined;
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        receipt = await Promise.race([
          this.provider.send(
            message.to,
            message.subject,
            message.text,
            message.html,
            {
              replyTo: this.replyTo,
            },
          ),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("email provider acceptance timed out")),
              this.deliveryTimeoutMs,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      // Receipt objects can come from third-party code. Keep validation inside
      // the redacting error boundary; the validator also rejects accessors.
      if (!isValidDeliveryReceipt(receipt)) {
        throw new Error("email provider returned no acceptance receipt");
      }
    } catch (err) {
      logger.error(
        {
          details: [
            "[steward:auth] email provider rejected send",
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:email] error",
      );
      throw new EmailDeliveryError();
    }
    return receipt;
  }

  private async markEmailLoginConsumed(challengeId: string): Promise<void> {
    const current = parseStatusRecord(
      await this.tokenStore.verify(emailLoginStatusKey(challengeId)),
    );
    if (!current || current.status !== "pending") return;
    const ttlMs = Math.max(
      1,
      new Date(current.expiresAt).getTime() - Date.now(),
    );
    await this.tokenStore.store(
      emailLoginStatusKey(challengeId),
      JSON.stringify({
        ...current,
        status: "consumed",
      } satisfies EmailLoginStatusRecord),
      ttlMs,
    );
  }

  private async publishChallenge(
    entries: readonly StorePublishEntry[],
    confirmOwnPublication?: () => Promise<boolean>,
  ): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const published = await this.tokenStore.publish(entries);
        if (published || !lastError || !confirmOwnPublication) return published;
        return await confirmOwnPublication();
      } catch (error) {
        lastError = error;
        if (confirmOwnPublication) {
          try {
            if (await confirmOwnPublication()) return true;
          } catch {
            // The durable outcome remains ambiguous; retry the atomic publish.
          }
        }
      }
    }
    throw lastError;
  }

  private async reserveIssuance(
    targetKey: string,
    reservationId: string,
    ttlMs: number,
  ): Promise<{
    reservationKey: string;
    reservation: string;
    prior: string | null;
  }> {
    const reservationKey = issuanceReservationKey(targetKey);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await this.tokenStore.verify(reservationKey);
      const prior =
        parseIssuanceReservation(current)?.prior ??
        (await this.tokenStore.verify(targetKey));
      const reservation = encodeIssuanceReservation(reservationId, prior);
      if (
        await this.publishChallenge([
          {
            key: reservationKey,
            value: reservation,
            expiresAt: Date.now() + ttlMs,
            expected: current,
          },
        ])
      ) {
        return { reservationKey, reservation, prior };
      }
    }
    throw new EmailDeliveryError("Email challenge activation failed");
  }

  private async releaseIssuance(
    reservationKey: string,
    reservation: string,
    ttlMs: number,
  ): Promise<void> {
    try {
      await this.publishChallenge([
        {
          key: reservationKey,
          value: null,
          expiresAt: Date.now() + ttlMs,
          expected: reservation,
        },
      ]);
    } catch {
      // A newer issuance may own the target. Never overwrite its reservation.
    }
  }

  private async discardStaging(key: string): Promise<void> {
    try {
      await this.tokenStore.delete(key);
    } catch {
      // Staging records are opaque and TTL-bounded; cleanup is best-effort.
    }
  }

  /**
   * Generate a magic link token, persist its hash, and send the email.
   * Returns the token hash (for verification lookup) and the expiry date.
   */
  async sendMagicLink(
    email: string,
    context: { tenantId?: string } = {},
  ): Promise<{
    tokenHash: string;
    expiresAt: Date;
    challengeId: string;
    pollSecret: string;
  }> {
    this.assertDeliveryConfigured();
    email = email.toLowerCase().trim();
    const token = generateToken();
    const tokenHash = hashToken(token);
    const code = generateOtpCode();
    const challengeId = generateOpaqueId();
    const pollSecret = generateOpaqueId();
    const ttlMs = Math.min(this.tokenTtlMs, DEFAULT_TTL_MS);
    const expiresAt = new Date(Date.now() + ttlMs);
    const targetKey = emailLoginTargetKey(email, context.tenantId);
    const {
      reservationKey,
      reservation,
      prior: priorChallengeId,
    } = await this.reserveIssuance(targetKey, challengeId, ttlMs);
    const publicationReceiptKey = issuancePublicationReceiptKey(reservation);
    const publicationReceipt = issuancePublicationMarker(reservation);

    const codeVerifier = this.codeVerifier(email, context.tenantId, code);
    const challenge: EmailLoginChallengeRecord = {
      status: "delivery_pending",
      challengeId,
      emailHash: this.emailHash(email, context.tenantId),
      tenantId: context.tenantId,
      purpose: EMAIL_LOGIN_PURPOSE,
      codeVerifier,
      pollSecretHash: this.pollSecretHash(challengeId, pollSecret),
      expiresAt: expiresAt.toISOString(),
    };
    const stagedStatus: EmailLoginStatusRecord = {
      status: "delivery_pending",
      challengeId,
      pollSecretHash: challenge.pollSecretHash,
      expiresAt: challenge.expiresAt,
    };

    const stagingKey = emailLoginStagingKey(challengeId);
    try {
      await this.tokenStore.store(stagingKey, JSON.stringify(challenge), ttlMs);
    } catch (error) {
      await Promise.all([
        this.releaseIssuance(reservationKey, reservation, ttlMs),
        this.discardStaging(stagingKey),
      ]);
      throw error;
    }

    // Build and send the email
    const magicLink = buildMagicLink(
      this.baseUrl,
      this.callbackPath,
      token,
      email,
      context.tenantId,
    );
    const rendered = this.templateRenderer(this.templateId, {
      magicLink,
      email,
      code,
      expiresInMinutes: Math.floor(ttlMs / (60 * 1000)),
      tenantName: this.brandName,
    });
    const subject = this.subjectOverride || rendered.subject;
    const body = rendered.text;
    const html = rendered.html;

    // Provider ambiguity never requires cleanup for safety: every persisted
    // record remains non-redeemable until the acceptance receipt is validated.
    try {
      await this.sendAccepted({ to: email, subject, text: body, html });
    } catch (error) {
      await Promise.all([
        this.releaseIssuance(reservationKey, reservation, ttlMs),
        this.discardStaging(stagingKey),
      ]);
      throw error;
    }

    const remainingTtlMs = expiresAt.getTime() - Date.now();
    if (remainingTtlMs <= 0) {
      await Promise.all([
        this.releaseIssuance(reservationKey, reservation, 1),
        this.discardStaging(stagingKey),
      ]);
      logger.error(
        {
          details: ["[steward:auth] email challenge expired before activation"],
        },
        "[Login:email] error",
      );
      throw new EmailDeliveryError("Email challenge activation failed");
    }
    try {
      // Publish only legacy-readable records. Until this atomic operation
      // commits, neither old nor new pods can discover the staged credential.
      const published = await this.publishChallenge(
        [
          { key: stagingKey, value: null, expiresAt: expiresAt.getTime() },
          ...(priorChallengeId
            ? [
                {
                  key: emailLoginChallengeKey(priorChallengeId),
                  value: null,
                  expiresAt: expiresAt.getTime(),
                },
                {
                  key: emailLoginStatusKey(priorChallengeId),
                  value: null,
                  expiresAt: expiresAt.getTime(),
                },
              ]
            : []),
          {
            key: emailLoginChallengeKey(challengeId),
            value: JSON.stringify({
              ...challenge,
              status: "pending",
            } satisfies EmailLoginChallengeRecord),
            expiresAt: expiresAt.getTime(),
          },
          {
            key: emailLoginStatusKey(challengeId),
            value: JSON.stringify({
              ...stagedStatus,
              status: "pending",
            } satisfies EmailLoginStatusRecord),
            expiresAt: expiresAt.getTime(),
          },
          {
            key: emailLoginLinkAliasKey(tokenHash),
            value: challengeId,
            expiresAt: expiresAt.getTime(),
          },
          {
            key: emailLoginCodeAliasKey(codeVerifier),
            value: challengeId,
            expiresAt: expiresAt.getTime(),
          },
          {
            key: targetKey,
            value: challengeId,
            expiresAt: expiresAt.getTime(),
            expected: priorChallengeId,
          },
          {
            key: reservationKey,
            value: publicationReceipt,
            expiresAt: expiresAt.getTime(),
            expected: reservation,
          },
          {
            key: publicationReceiptKey,
            value: publicationReceipt,
            expiresAt: expiresAt.getTime(),
            expected: null,
          },
        ],
        async () =>
          (await this.tokenStore.verify(publicationReceiptKey)) ===
            publicationReceipt &&
          (await this.tokenStore.verify(targetKey)) === challengeId,
      );
      if (!published) throw new Error("email issuance was superseded");
    } catch (err) {
      await Promise.all([
        this.releaseIssuance(reservationKey, reservation, remainingTtlMs),
        this.discardStaging(stagingKey),
      ]);
      logger.error(
        {
          details: [
            "[steward:auth] email challenge activation failed",
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:email] error",
      );
      throw new EmailDeliveryError("Email challenge activation failed");
    }

    return { tokenHash, expiresAt, challengeId, pollSecret };
  }

  /**
   * Generate a 6-digit one-time code, persist its hash, and email it.
   * Privy-style email verification: the code proves address ownership and
   * is exchanged for a short-lived verified-email grant by the API layer.
   */
  async sendOtp(
    email: string,
    context: { tenantId?: string; tenantName?: string } = {},
  ): Promise<{ expiresAt: Date }> {
    this.assertDeliveryConfigured();
    email = email.toLowerCase().trim();
    let code = generateOtpCode();
    const stagingId = generateOpaqueId();
    const expiresAt = new Date(Date.now() + this.tokenTtlMs);

    const targetKey = otpTargetKey(email, context.tenantId);
    const {
      reservationKey,
      reservation,
      prior: priorStoreKey,
    } = await this.reserveIssuance(targetKey, stagingId, this.tokenTtlMs);
    const publicationReceiptKey = issuancePublicationReceiptKey(reservation);
    const publicationReceipt = issuancePublicationMarker(reservation);
    let storeKey = otpStoreKey(email, context.tenantId, code);
    // A repeated six-digit code would derive the prior issuance's exact key
    // and make an old email valid again. Regenerate before superseding it.
    for (
      let attempt = 0;
      priorStoreKey && storeKey === priorStoreKey && attempt < 10;
      attempt += 1
    ) {
      code = generateOtpCode();
      storeKey = otpStoreKey(email, context.tenantId, code);
    }
    if (priorStoreKey && storeKey === priorStoreKey) {
      await this.releaseIssuance(reservationKey, reservation, this.tokenTtlMs);
      throw new EmailDeliveryError(
        "Could not generate a fresh email challenge",
      );
    }
    const payload = { email, tenantId: context.tenantId };
    const stagingKey = otpStagingKey(stagingId);
    try {
      await this.tokenStore.store(
        stagingKey,
        encodeOtpChallenge("delivery_pending"),
        Math.min(this.tokenTtlMs, DEFAULT_TTL_MS),
      );
    } catch (error) {
      await Promise.all([
        this.releaseIssuance(reservationKey, reservation, this.tokenTtlMs),
        this.discardStaging(stagingKey),
      ]);
      throw error;
    }

    const minutes = Math.floor(this.tokenTtlMs / (60 * 1000));
    const brand = context.tenantName || this.brandName || "elizaOS";
    const rendered = this.otpTemplateRenderer(this.templateId, {
      email,
      code,
      brandName: brand,
      expiresInMinutes: minutes,
    });

    try {
      await this.sendAccepted({
        to: email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
    } catch (error) {
      await Promise.all([
        this.releaseIssuance(reservationKey, reservation, this.tokenTtlMs),
        this.discardStaging(stagingKey),
      ]);
      throw error;
    }
    const remainingTtlMs = expiresAt.getTime() - Date.now();
    if (remainingTtlMs <= 0) {
      await Promise.all([
        this.releaseIssuance(reservationKey, reservation, 1),
        this.discardStaging(stagingKey),
      ]);
      logger.error(
        { details: ["[steward:auth] email OTP expired before activation"] },
        "[Login:email] error",
      );
      throw new EmailDeliveryError("Email challenge activation failed");
    }
    try {
      const published = await this.publishChallenge(
        [
          { key: stagingKey, value: null, expiresAt: expiresAt.getTime() },
          ...(priorStoreKey
            ? [
                {
                  key: priorStoreKey,
                  value: null,
                  expiresAt: expiresAt.getTime(),
                },
              ]
            : []),
          {
            key: storeKey,
            // Deployed pre-staging readers accept only the raw two-field payload.
            value: JSON.stringify(payload),
            expiresAt: expiresAt.getTime(),
          },
          {
            key: targetKey,
            value: storeKey,
            expiresAt: expiresAt.getTime(),
            expected: priorStoreKey,
          },
          {
            key: reservationKey,
            value: publicationReceipt,
            expiresAt: expiresAt.getTime(),
            expected: reservation,
          },
          {
            key: publicationReceiptKey,
            value: publicationReceipt,
            expiresAt: expiresAt.getTime(),
            expected: null,
          },
        ],
        async () =>
          (await this.tokenStore.verify(publicationReceiptKey)) ===
            publicationReceipt &&
          (await this.tokenStore.verify(targetKey)) === storeKey,
      );
      if (!published) throw new Error("email issuance was superseded");
    } catch (err) {
      await Promise.all([
        this.releaseIssuance(reservationKey, reservation, remainingTtlMs),
        this.discardStaging(stagingKey),
      ]);
      logger.error(
        {
          details: [
            "[steward:auth] email OTP activation failed",
            redactedThrownDiagnostics(err),
          ],
        },
        "[Login:email] error",
      );
      throw new EmailDeliveryError("Email challenge activation failed");
    }

    return { expiresAt };
  }

  /**
   * Verify a 6-digit code for {email, tenantId}. One-time use: the code is
   * consumed on success. Returns false for unknown/expired/mismatched codes.
   */
  async verifyOtp(
    email: string,
    code: string,
    tenantId?: string,
  ): Promise<boolean> {
    if (!/^\d{6}$/.test(code)) return false;
    const legacyEmail = email.trim();
    email = legacyEmail.toLowerCase();
    const storeKey = otpStoreKey(email, tenantId, code);
    let resolvedStoreKey = storeKey;
    let stored = await this.tokenStore.verify(resolvedStoreKey);
    if (!stored && legacyEmail !== email) {
      resolvedStoreKey = otpStoreKey(legacyEmail, tenantId, code);
      stored = await this.tokenStore.verify(resolvedStoreKey);
    }
    const current = decodeOtpChallenge(stored);
    if (!current) {
      // Rolling-deploy compatibility for codes issued before staged delivery.
      if (!stored) return false;
      const consumed = await this.tokenStore.consume(resolvedStoreKey);
      if (!consumed) return false;
      const legacy = decodeLegacyOtpPayload(consumed);
      if (!legacy) return false;
      return (
        legacy.email.toLowerCase().trim() === email &&
        (legacy.tenantId ?? undefined) === (tenantId ?? undefined)
      );
    }
    if (
      current.status !== "active" ||
      (await this.tokenStore.verify(otpTargetKey(email, tenantId))) !== storeKey
    ) {
      return false;
    }
    const consumed = decodeOtpChallenge(
      await this.tokenStore.consume(storeKey),
    );
    if (!consumed || consumed.status !== "active") return false;
    return (
      consumed.payload.email === email &&
      (consumed.payload.tenantId ?? undefined) === (tenantId ?? undefined)
    );
  }

  async sendTenantInvitation(
    email: string,
    context: TenantInvitationEmailContext,
  ): Promise<void> {
    this.assertDeliveryConfigured();
    const acceptLink = buildInvitationLink(
      this.baseUrl,
      context.acceptPath ?? "/accept-invitation",
      context.token,
      context.tenantId,
      email,
    );
    const expiresAt = context.expiresAt.toISOString();
    const tenantLabel = context.tenantName || context.tenantId;
    const subject = `You're invited to ${tenantLabel} on elizaOS`;
    const text = [
      `You've been invited to join ${tenantLabel} on elizaOS.`,
      "",
      "Open this link to accept the invitation:",
      "",
      acceptLink,
      "",
      `This invitation expires at ${expiresAt}.`,
      "If you were not expecting this invitation, you can ignore this email.",
      "",
      "— elizaOS",
    ].join("\n");
    const escapedTenant = escapeHtml(tenantLabel);
    const escapedLink = escapeHtml(acceptLink);
    const escapedExpiresAt = escapeHtml(expiresAt);
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#0b0a09;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b0a09;min-height:100vh;">
    <tr><td align="center" style="padding:60px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;">
        <tr><td style="background-color:#141210;border:1px solid #2a2722;padding:40px 32px;">
          <div style="font-size:22px;font-weight:700;color:#e8e5e0;padding-bottom:8px;">Join ${escapedTenant}</div>
          <div style="font-size:14px;color:#9c9788;line-height:1.5;padding-bottom:32px;">You've been invited to elizaOS. This invitation expires at ${escapedExpiresAt}.</div>
          <div style="text-align:center;padding-bottom:32px;">
            <a href="${escapedLink}" target="_blank" style="display:inline-block;background-color:#c4873a;color:#0b0a09;font-size:14px;font-weight:600;text-decoration:none;padding:12px 32px;">Accept invitation</a>
          </div>
          <div style="border-top:1px solid #2a2722;padding-top:24px;font-size:11px;color:#9c9788;word-break:break-all;line-height:1.5;">${escapedLink}</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    // The invitation token's persistence is owned by the caller (it is stored
    // hashed in tenant_invitations before this call); surface a typed error so
    // callers report emailSent=false instead of a false green. Nothing here is
    // invalidated because EmailAuth does not own that record.
    await this.sendAccepted({ to: email, subject, text, html });
  }

  /**
   * Verify a raw token received from the callback URL.
   * One-time use: deletes the token after successful verification.
   */
  async verifyMagicLink(
    token: string,
    email?: string,
    tenantId?: string,
  ): Promise<EmailLoginVerifyResult> {
    const tokenHash = hashToken(token);
    const challengeId = await this.tokenStore.verify(
      emailLoginLinkAliasKey(tokenHash),
    );

    if (!challengeId) {
      const legacy = await this.tokenStore.consume(tokenHash);
      if (!legacy) return { email: "", valid: false };
      const payload = decodeMagicLinkPayload(legacy);
      return {
        email: payload.email,
        tenantId: payload.tenantId,
        valid: true,
        challengeId: "",
      };
    }
    const payload = parseEmailLoginChallenge(
      await this.tokenStore.verify(emailLoginChallengeKey(challengeId)),
    );
    if (!payload || payload.status !== "active") {
      return { email: "", valid: false };
    }

    const normalizedEmail = email?.toLowerCase().trim();
    const resolvedTenantId = tenantId ?? payload.tenantId;
    if (
      !normalizedEmail ||
      (payload.tenantId ?? undefined) !== (resolvedTenantId ?? undefined) ||
      payload.emailHash !== this.emailHash(normalizedEmail, resolvedTenantId)
    ) {
      return { email: "", valid: false };
    }
    if (
      (await this.tokenStore.verify(
        emailLoginTargetKey(normalizedEmail, resolvedTenantId),
      )) !== challengeId
    ) {
      return { email: "", valid: false };
    }
    const consumed = parseEmailLoginChallenge(
      await this.tokenStore.consume(emailLoginChallengeKey(challengeId)),
    );
    if (!consumed || consumed.status !== "active")
      return { email: "", valid: false };
    await Promise.allSettled([
      this.tokenStore.delete(emailLoginLinkAliasKey(tokenHash)),
      this.tokenStore.delete(emailLoginCodeAliasKey(payload.codeVerifier)),
      this.markEmailLoginConsumed(challengeId),
    ]);
    return {
      email: normalizedEmail,
      tenantId: payload.tenantId,
      valid: true,
      challengeId,
    };
  }

  async verifyEmailLoginCode(
    email: string,
    code: string,
    tenantId?: string,
  ): Promise<EmailLoginVerifyResult> {
    email = email.toLowerCase().trim();
    if (!/^\d{6}$/.test(code)) {
      const reason = await this.recordEmailLoginCodeFailure(email, tenantId);
      return {
        email: "",
        valid: false,
        reason: reason === "locked" ? "locked" : "invalid",
      };
    }
    const verifier = this.codeVerifier(email, tenantId, code);
    const challengeId = await this.tokenStore.verify(
      emailLoginCodeAliasKey(verifier),
    );
    if (!challengeId) {
      const reason = await this.recordEmailLoginCodeFailure(email, tenantId);
      return {
        email: "",
        valid: false,
        reason: reason === "locked" ? "locked" : "invalid",
      };
    }
    const payload = parseEmailLoginChallenge(
      await this.tokenStore.verify(emailLoginChallengeKey(challengeId)),
    );
    if (
      !payload ||
      payload.status !== "active" ||
      (payload.tenantId ?? undefined) !== (tenantId ?? undefined) ||
      payload.emailHash !== this.emailHash(email, tenantId)
    ) {
      return { email: "", valid: false };
    }
    if (
      (await this.tokenStore.verify(emailLoginTargetKey(email, tenantId))) !==
      challengeId
    ) {
      return { email: "", valid: false };
    }
    const consumed = parseEmailLoginChallenge(
      await this.tokenStore.consume(emailLoginChallengeKey(challengeId)),
    );
    if (!consumed || consumed.status !== "active")
      return { email: "", valid: false };
    await Promise.allSettled([
      this.tokenStore.delete(emailLoginCodeAliasKey(verifier)),
      this.markEmailLoginConsumed(challengeId),
    ]);
    return { email, tenantId: payload.tenantId, valid: true, challengeId };
  }

  /**
   * Record a failed code attempt against the pending challenge; locks the
   * challenge after MAX_EMAIL_LOGIN_CODE_ATTEMPTS failures.
   *
   * Accepted trade-off (SEC-136): the attempt counter is keyed by email, so
   * anyone who knows a victim's address can burn the attempts and force the
   * victim to re-request a code. That is inherent to any attempt limiter —
   * the alternative (no limiter) leaves the 6-digit code brute-forceable.
   * Impact is availability-only (re-request); no code is ever confirmed or
   * consumed by failed attempts.
   */
  async recordEmailLoginCodeFailure(
    email: string,
    tenantId?: string,
  ): Promise<"failed" | "locked"> {
    const challengeId = await this.tokenStore.verify(
      emailLoginTargetKey(email, tenantId),
    );
    if (!challengeId) return "failed";
    const challenge = parseEmailLoginChallenge(
      await this.tokenStore.verify(emailLoginChallengeKey(challengeId)),
    );
    if (!challenge || challenge.status !== "active") {
      const status = parseStatusRecord(
        await this.tokenStore.verify(emailLoginStatusKey(challengeId)),
      );
      return status?.status === "locked" ? "locked" : "failed";
    }
    const ttlMs = Math.max(
      1,
      new Date(challenge.expiresAt).getTime() - Date.now(),
    );
    for (let i = 1; i <= MAX_EMAIL_LOGIN_CODE_ATTEMPTS; i++) {
      const reserved = await this.tokenStore.setIfNotExists(
        emailLoginFailureKey(challengeId, i),
        "1",
        ttlMs,
      );
      if (reserved) {
        if (i === MAX_EMAIL_LOGIN_CODE_ATTEMPTS) {
          await this.tokenStore.consume(emailLoginChallengeKey(challengeId));
          await this.tokenStore.delete(
            emailLoginCodeAliasKey(challenge.codeVerifier),
          );
          await this.tokenStore.store(
            emailLoginStatusKey(challengeId),
            JSON.stringify({
              status: "locked",
              challengeId,
              pollSecretHash: challenge.pollSecretHash,
              expiresAt: challenge.expiresAt,
            } satisfies EmailLoginStatusRecord),
            ttlMs,
          );
          return "locked";
        }
        return "failed";
      }
    }
    return "locked";
  }

  async getEmailLoginStatus(
    challengeId: string,
    pollSecret: string,
  ): Promise<EmailLoginChallengeStatus> {
    const current = parseStatusRecord(
      await this.tokenStore.verify(emailLoginStatusKey(challengeId)),
    );
    if (!current) return { status: "expired" };
    if (
      !this.pollSecretMatches(challengeId, pollSecret, current.pollSecretHash)
    ) {
      return { status: "invalid" };
    }
    return current.status === "pending"
      ? { status: "pending", expiresAt: current.expiresAt }
      : current.status === "delivery_pending"
        ? { status: "invalid" }
        : { status: current.status };
  }

  /**
   * Clean up background timers.  Call in tests after each suite.
   */
  destroy(): void {
    this.tokenStore.destroy();
  }
}
