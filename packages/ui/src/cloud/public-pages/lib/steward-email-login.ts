/**
 * Browser HTTP adapter for Steward's email magic-link sign-in contract.
 *
 * The UI calls these endpoints directly through the configured Steward mount
 * because the installed SDK can lag API rollout. Status polling intentionally
 * returns only challenge state; it never hydrates a session on the polling
 * device.
 */

import type { StewardAuthResult, StewardMfaRequiredResult } from "@stwd/sdk";

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
  return object(payload?.data) ?? payload ?? {};
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
  return (await request(options, "/auth/email/code/verify", {
    email,
    code,
  })) as unknown as StewardAuthResult | StewardMfaRequiredResult;
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
