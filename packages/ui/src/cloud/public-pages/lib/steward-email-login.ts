/**
 * Browser HTTP adapter for Steward's email magic-link sign-in contract.
 *
 * The UI calls these endpoints directly through the configured Steward mount
 * because the installed SDK can lag API rollout. Status polling intentionally
 * returns only challenge state; it never hydrates a session on the polling
 * device.
 */

import type { LoginAuthResult, LoginMfaRequiredResult } from "@elizaos/auth";
import { generateStewardOAuthState } from "@elizaos/plugin-elizacloud/steward-session-client";
import { sanitizeLoginReturnTo } from "./login-return-to";
import { createStewardPkcePair } from "./steward-oauth-url";

export interface StewardEmailBrowserBinding {
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  redirectUri: string;
}

interface StewardEmailBrowserProof {
  binding: StewardEmailBrowserBinding;
  verifier: string;
  email: string;
  tenantId: string;
  returnTo: string | null;
  expiresAt: number;
}

const EMAIL_PROOF_PREFIX = "eliza.login.email.proof.";
const EMAIL_PROOF_TTL_MS = 10 * 60 * 1000;
const EMAIL_STATE = /^[A-Za-z0-9_-]{16,256}$/;

function readEmailProof(state: string): StewardEmailBrowserProof | null {
  if (!EMAIL_STATE.test(state)) return null;
  try {
    const value = JSON.parse(
      window.localStorage.getItem(EMAIL_PROOF_PREFIX + state) ?? "null",
    ) as StewardEmailBrowserProof | null;
    if (
      !value ||
      value.binding?.state !== state ||
      value.binding.codeChallengeMethod !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.binding.codeChallenge) ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(value.verifier) ||
      typeof value.email !== "string" ||
      typeof value.tenantId !== "string" ||
      typeof value.binding.redirectUri !== "string" ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now() ||
      (value.returnTo !== null &&
        sanitizeLoginReturnTo(value.returnTo) === null)
    )
      return null;
    return value;
  } catch {
    // An unreadable proof cannot authorize an exchange.
    return null;
  }
}

/** Origin-shared, state-keyed proof lets an emailed link open in a new tab without touching OAuth state. */
export async function prepareStewardEmailBrowserBinding(input: {
  email: string;
  tenantId: string;
  redirectUri: string;
  returnTo: string | null;
  previousState?: string;
}): Promise<StewardEmailBrowserBinding> {
  const email = input.email.trim().toLowerCase();
  const previous = input.previousState
    ? readEmailProof(input.previousState)
    : null;
  let proof: StewardEmailBrowserProof;
  if (
    previous &&
    previous.email === email &&
    previous.tenantId === input.tenantId &&
    previous.binding.redirectUri === input.redirectUri
  ) {
    proof = { ...previous, expiresAt: Date.now() + EMAIL_PROOF_TTL_MS };
  } else {
    const pkce = await createStewardPkcePair();
    proof = {
      binding: {
        state: generateStewardOAuthState(),
        codeChallenge: pkce.challenge,
        codeChallengeMethod: "S256",
        redirectUri: input.redirectUri,
      },
      verifier: pkce.verifier,
      email,
      tenantId: input.tenantId,
      returnTo: sanitizeLoginReturnTo(input.returnTo),
      expiresAt: Date.now() + EMAIL_PROOF_TTL_MS,
    };
  }
  try {
    window.localStorage.setItem(
      EMAIL_PROOF_PREFIX + proof.binding.state,
      JSON.stringify(proof),
    );
  } catch {
    throw new Error(
      "This browser cannot keep sign-in proof. Enable site storage and try again.",
    );
  }
  return proof.binding;
}

export function discardStewardEmailBrowserBinding(state: string): void {
  if (!EMAIL_STATE.test(state)) return;
  try {
    window.localStorage.removeItem(EMAIL_PROOF_PREFIX + state);
  } catch {
    // An unavailable local store cannot authorize a subsequent exchange.
  }
}

export function consumeStewardEmailBrowserProof(
  state: string,
  tenantId: string,
  redirectUri: string,
): StewardEmailBrowserProof | null {
  const proof = readEmailProof(state);
  if (
    !proof ||
    proof.tenantId !== tenantId ||
    proof.binding.redirectUri !== redirectUri
  )
    return null;
  // Remove only the exact matched email proof. The server also consumes the code once.
  try {
    window.localStorage.removeItem(EMAIL_PROOF_PREFIX + state);
    return proof;
  } catch {
    return null;
  }
}

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
  /**
   * Whether the rendered Steward email actually carried a six-digit companion
   * code. `true`/`false` only when the send response explicitly declares the
   * delivered factors (`deliveredFactors` or `codeDelivery`); `undefined` when
   * Steward did not say. `challengeId`/`pollSecret` are status-polling
   * credentials and must never be treated as proof a code was emailed —
   * tenant templates may render the magic link only (#19213).
   */
  emailCodeDelivered?: boolean;
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

function isStewardUser(value: unknown): value is LoginAuthResult["user"] {
  const user = object(value);
  if (!user || typeof user.id !== "string") return false;
  if (user.email !== null && typeof user.email !== "string") return false;
  if (
    user.walletAddress !== undefined &&
    typeof user.walletAddress !== "string"
  ) {
    return false;
  }
  if (
    user.walletChain !== undefined &&
    user.walletChain !== "ethereum" &&
    user.walletChain !== "solana"
  ) {
    return false;
  }
  if (user.isGuest !== undefined && typeof user.isGuest !== "boolean") {
    return false;
  }
  if (
    user.guestExpiresAt !== undefined &&
    user.guestExpiresAt !== null &&
    typeof user.guestExpiresAt !== "string"
  ) {
    return false;
  }
  if (user.tenantId !== undefined && typeof user.tenantId !== "string") {
    return false;
  }
  return (
    user.alreadyUpgraded === undefined ||
    typeof user.alreadyUpgraded === "boolean"
  );
}

function isStewardAuthResult(value: unknown): value is LoginAuthResult {
  const data = object(value);
  return (
    data !== null &&
    typeof data.token === "string" &&
    typeof data.refreshToken === "string" &&
    typeof data.expiresIn === "number" &&
    Number.isFinite(data.expiresIn) &&
    isStewardUser(data.user)
  );
}

type StewardMfaPayload = Pick<
  LoginMfaRequiredResult,
  "mfaRequired" | "mfa" | "user"
>;

function isStewardMfaPayload(value: unknown): value is StewardMfaPayload {
  const data = object(value);
  const mfa = object(data?.mfa);
  return (
    data?.mfaRequired === true &&
    mfa !== null &&
    (mfa.type === "totp" || mfa.type === "sms" || mfa.type === "passkey") &&
    typeof mfa.challengeId === "string" &&
    typeof mfa.expiresAt === "string" &&
    isStewardUser(data.user)
  );
}

async function request(
  options: StewardEmailLoginOptions,
  path: string,
  body: Record<string, unknown>,
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
  const payload = object(await response.json().catch(() => null));
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
  const data = object(payload?.data) ?? payload;
  if (!data) {
    throw new StewardEmailLoginError(
      "Steward email sign-in response was malformed.",
      502,
    );
  }
  return data;
}

export async function startStewardEmailLogin(
  options: StewardEmailLoginOptions,
  email: string,
  browserBinding?: StewardEmailBrowserBinding,
): Promise<StewardEmailLoginChallenge> {
  const data = await request(options, "/auth/email/send", {
    email,
    ...(browserBinding ? { browserBinding } : {}),
  });
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
  return {
    expiresAt,
    challengeId,
    pollSecret,
    emailCodeDelivered: parseEmailCodeDelivered(data),
  };
}

/**
 * Reads the explicit delivery declaration from a Steward send response.
 * Recognizes `deliveredFactors: string[]` (authoritative factor list derived
 * from the rendered template) and the shorthand `codeDelivery: "email" |
 * "none"`. Anything else — including today's responses that carry only
 * `expiresAt`/`challengeId`/`pollSecret` — yields `undefined`: the client
 * does not know which factors the email carried and must not assert one.
 */
function parseEmailCodeDelivered(
  data: Record<string, unknown>,
): boolean | undefined {
  const factors = data.deliveredFactors;
  if (Array.isArray(factors) && factors.every((f) => typeof f === "string")) {
    return factors.includes("email_code") || factors.includes("code");
  }
  const codeDelivery = string(data.codeDelivery);
  if (codeDelivery === "email") return true;
  if (codeDelivery === "none") return false;
  return undefined;
}

export async function verifyStewardEmailSignInCode(
  options: StewardEmailLoginOptions,
  email: string,
  code: string,
): Promise<LoginAuthResult | LoginMfaRequiredResult> {
  const data = await request(options, "/auth/email/code/verify", {
    email,
    code,
  });
  if (isStewardAuthResult(data)) {
    return data;
  }
  if (isStewardMfaPayload(data)) {
    return {
      ok: true,
      mfaRequired: true,
      mfa: data.mfa,
      user: data.user,
    };
  }
  throw new StewardEmailLoginError(
    "Steward email sign-in response was malformed.",
    502,
  );
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
