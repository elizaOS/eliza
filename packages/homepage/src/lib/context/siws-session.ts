/** Validates and atomically commits a SIWS session after canonical identity confirmation. */

import type { SiwsVerifyResponse } from "@/lib/api/siws";

const IDENTITY_FIELD_MAX_BYTES = 256;

interface CanonicalSiwsIdentity {
  user: { id: string; organization_id: string | null };
  organization: { id: string } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeIdentifier(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > IDENTITY_FIELD_MAX_BYTES
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  return true;
}

export function assertCanonicalSiwsIdentity(
  verified: SiwsVerifyResponse,
  value: unknown,
): asserts value is CanonicalSiwsIdentity {
  if (
    verified.organization === null ||
    !isRecord(value) ||
    !isRecord(value.user) ||
    !isSafeIdentifier(value.user.id) ||
    !isSafeIdentifier(value.user.organization_id) ||
    !isRecord(value.organization) ||
    !isSafeIdentifier(value.organization.id) ||
    value.user.id !== verified.user.id ||
    value.user.organization_id !== verified.user.organization_id ||
    value.organization.id !== verified.organization.id ||
    value.organization.id !== value.user.organization_id
  ) {
    throw new Error("Canonical SIWS identity does not match verification");
  }
}

export async function confirmSiwsSession<T>(
  apiKey: string,
  dependencies: {
    loadCanonicalUser: (token: string) => Promise<T>;
    validateCanonicalUser: (value: T) => void;
    isCurrentAttempt: () => boolean;
    storeToken: (token: string) => void;
    publishCanonicalUser: (value: T) => void;
  },
): Promise<void> {
  const canonicalUser = await dependencies.loadCanonicalUser(apiKey);
  dependencies.validateCanonicalUser(canonicalUser);
  if (!dependencies.isCurrentAttempt()) {
    throw new Error("SIWS session attempt was superseded");
  }

  // Persist first so a storage failure cannot publish identity for a bearer
  // that no observer can subsequently load.
  dependencies.storeToken(apiKey);
  dependencies.publishCanonicalUser(canonicalUser);
}
