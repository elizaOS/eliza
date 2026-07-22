/**
 * Browser HTTP adapter for Steward's email magic-link sign-in contract.
 *
 * The UI calls these endpoints directly through the configured Steward mount
 * because the installed SDK can lag API rollout. Status polling intentionally
 * returns only challenge state; it never hydrates a session on the polling
 * device.
 */

import type {
  StewardAuthResult,
  StewardMfaRequiredResult,
  StewardUser,
} from "@stwd/sdk";

export type StewardEmailLoginStatus =
  | "pending"
  | "consumed"
  | "locked"
  | "expired"
  | "invalid";

export interface StewardEmailLoginChallenge {
  expiresAt: string | number;
  challengeId?: string;
  pollSecret?: string;
}

interface StewardEmailLoginOptions {
  baseUrl: string;
  tenantId?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export class StewardEmailLoginError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "StewardEmailLoginError";
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stewardUser(value: unknown): StewardUser | null {
  const data = object(value);
  if (!data) return null;

  const id = string(data.id);
  const email = data.email === null ? null : string(data.email);
  const walletAddress = string(data.walletAddress);
  const tenantId = string(data.tenantId);
  const guestExpiresAt =
    data.guestExpiresAt === null ? null : string(data.guestExpiresAt);
  const walletChain = data.walletChain;
  const isGuest = data.isGuest;
  const alreadyUpgraded = data.alreadyUpgraded;

  if (
    !id ||
    email === undefined ||
    (data.walletAddress !== undefined && walletAddress === undefined) ||
    (walletChain !== undefined &&
      walletChain !== "ethereum" &&
      walletChain !== "solana") ||
    (data.isGuest !== undefined && typeof isGuest !== "boolean") ||
    (data.guestExpiresAt !== undefined && guestExpiresAt === undefined) ||
    (data.tenantId !== undefined && tenantId === undefined) ||
    (data.alreadyUpgraded !== undefined && typeof alreadyUpgraded !== "boolean")
  ) {
    return null;
  }

  return {
    id,
    email,
    ...(walletAddress !== undefined ? { walletAddress } : {}),
    ...(walletChain !== undefined ? { walletChain } : {}),
    ...(typeof isGuest === "boolean" ? { isGuest } : {}),
    ...(guestExpiresAt !== undefined ? { guestExpiresAt } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(typeof alreadyUpgraded === "boolean" ? { alreadyUpgraded } : {}),
  };
}

function stewardEmailVerifyResult(
  data: Record<string, unknown>,
): StewardAuthResult | StewardMfaRequiredResult {
  const user = stewardUser(data.user);
  if (data.mfaRequired === true) {
    const mfa = object(data.mfa);
    const type = mfa?.type;
    const challengeId = string(mfa?.challengeId);
    const expiresAt = string(mfa?.expiresAt);
    if (
      data.ok === true &&
      user &&
      (type === "totp" || type === "sms" || type === "passkey") &&
      challengeId &&
      expiresAt
    ) {
      return {
        ok: true,
        mfaRequired: true,
        mfa: { type, challengeId, expiresAt },
        user,
      };
    }
  } else {
    const token = string(data.token);
    const refreshToken = string(data.refreshToken);
    const expiresIn = data.expiresIn;
    if (
      token &&
      refreshToken &&
      typeof expiresIn === "number" &&
      Number.isFinite(expiresIn) &&
      user
    ) {
      return { token, refreshToken, expiresIn, user };
    }
  }

  throw new StewardEmailLoginError(
    "Steward email code verification response was malformed.",
    502,
  );
}

async function request(
  options: StewardEmailLoginOptions,
  path: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${options.baseUrl.replace(/\/$/, "")}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(
        options.tenantId ? { ...body, tenantId: options.tenantId } : body,
      ),
      signal: options.signal,
    },
  );
  let payload: Record<string, unknown> | null = null;
  try {
    payload = object(await response.json());
  } catch {
    // error-policy:J3 The remote body is untrusted input. A malformed body is
    // an explicit transport failure, never an empty payload that callers could
    // mistake for a valid response.
    throw new StewardEmailLoginError(
      "Steward email sign-in response was malformed.",
      response.ok ? 502 : response.status,
    );
  }
  if (!response.ok) {
    const nested = object(payload?.error);
    throw new StewardEmailLoginError(
      string(nested?.message) ??
        string(payload?.error) ??
        "Steward email sign-in failed.",
      response.status,
      string(nested?.code) ?? string(payload?.code),
    );
  }
  if (!payload) {
    throw new StewardEmailLoginError(
      "Steward email sign-in response was malformed.",
      502,
    );
  }
  return object(payload.data) ?? payload;
}

export async function startStewardEmailLogin(
  options: StewardEmailLoginOptions,
  email: string,
): Promise<StewardEmailLoginChallenge> {
  const data = await request(options, "/auth/email/send", { email });
  const expiresAt =
    string(data.expiresAt) ??
    (typeof data.expiresAt === "number" ? data.expiresAt : undefined);
  const challengeId = string(data.challengeId);
  const pollSecret = string(data.pollSecret);
  if (expiresAt === undefined) {
    throw new StewardEmailLoginError(
      "Steward email sign-in response was malformed.",
      502,
    );
  }
  // challengeId/pollSecret are additive in Steward #242. Their absence keeps
  // the existing magic-link-only UI working during a rolling deployment.
  return { expiresAt, challengeId, pollSecret };
}

export async function verifyStewardEmailSignInCode(
  options: StewardEmailLoginOptions,
  email: string,
  code: string,
): Promise<StewardAuthResult | StewardMfaRequiredResult> {
  const data = await request(options, "/auth/email/code/verify", {
    email,
    code,
  });
  return stewardEmailVerifyResult(data);
}

export async function pollStewardEmailSignInStatus(
  options: StewardEmailLoginOptions,
  challengeId: string,
  pollSecret: string,
): Promise<StewardEmailLoginStatus> {
  const data = await request(options, "/auth/email/status", {
    challengeId,
    pollSecret,
  });
  const status = string(data.status);
  if (
    status !== "pending" &&
    status !== "consumed" &&
    status !== "locked" &&
    status !== "expired" &&
    status !== "invalid"
  ) {
    throw new StewardEmailLoginError(
      "Steward email sign-in status response was malformed.",
      502,
    );
  }
  return status;
}
