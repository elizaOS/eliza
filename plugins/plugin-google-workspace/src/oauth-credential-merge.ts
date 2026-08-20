/**
 * Bounds the nested `tokens`/`oauthTokens` walk that flattens untrusted
 * Google OAuth credential JSON onto `Auth.Credentials`. A hostile nest
 * RangeError'd mergeCredentialObject at 8k depth on Node 24.15.0. Depth,
 * node, and cycle limits are all load-bearing.
 */

import { ElizaError } from "@elizaos/core";

export const MAX_OAUTH_CREDENTIAL_DEPTH = 32;
export const MAX_OAUTH_CREDENTIAL_NODES = 2_048;
export const GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED = "GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED";

export type OauthCredentialFields = {
  access_token?: string | null;
  refresh_token?: string | null;
  id_token?: string | null;
  token_type?: string | null;
  scope?: string | null;
  expiry_date?: number | null;
};

type WalkContext = {
  visits: number;
  visiting: WeakSet<object>;
};

function failUnbounded(context: Record<string, unknown>): never {
  throw new ElizaError("Google OAuth credential JSON exceeds the token-merge walk budget", {
    code: GOOGLE_OAUTH_CREDENTIAL_UNBOUNDED,
    context,
    severity: "fatal",
  });
}

function reserve(ctx: WalkContext, count: number): void {
  if (count > MAX_OAUTH_CREDENTIAL_NODES - ctx.visits) {
    failUnbounded({
      visits: ctx.visits + count,
      maxNodes: MAX_OAUTH_CREDENTIAL_NODES,
    });
  }
  ctx.visits += count;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function dataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readStringFromRecord(record: object, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(dataValue(record, key));
    if (value) return value;
  }
  return undefined;
}

function readScopeArray(scopes: unknown[], ctx: WalkContext): string {
  const length = dataValue(scopes, "length");
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    failUnbounded({ invalidScopesLength: length });
  }
  reserve(ctx, length as number);

  const values: string[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(scopes, String(index));
    if (!descriptor) continue;
    if (!("value" in descriptor)) {
      failUnbounded({ accessor: `scopes[${index}]` });
    }
    if (typeof descriptor.value === "string") {
      values.push(descriptor.value);
    }
  }
  return values.join(" ");
}

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return parseExpiry(numeric);
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

export function mergeCredentialObject(credentials: OauthCredentialFields, value: unknown): void {
  mergeCredentialObjectInner(credentials, value, 0, {
    visits: 0,
    visiting: new WeakSet<object>(),
  });
}

function mergeCredentialObjectInner(
  credentials: OauthCredentialFields,
  value: unknown,
  depth: number,
  ctx: WalkContext,
  visitAlreadyReserved = false
): void {
  if (depth > MAX_OAUTH_CREDENTIAL_DEPTH) {
    failUnbounded({ depth, max: MAX_OAUTH_CREDENTIAL_DEPTH });
  }
  const record = asRecord(value);
  if (!record) return;
  if (!visitAlreadyReserved) reserve(ctx, 1);
  if (ctx.visiting.has(record)) {
    failUnbounded({ cycle: true });
  }
  ctx.visiting.add(record);
  try {
    const nested =
      asRecord(dataValue(record, "tokens")) ?? asRecord(dataValue(record, "oauthTokens"));
    if (nested) {
      mergeCredentialObjectInner(credentials, nested, depth + 1, ctx);
    }

    const accessToken = readStringFromRecord(record, "access_token", "accessToken");
    const refreshToken = readStringFromRecord(record, "refresh_token", "refreshToken");
    const idToken = readStringFromRecord(record, "id_token", "idToken");
    const tokenType = readStringFromRecord(record, "token_type", "tokenType");
    const scope = readStringFromRecord(record, "scope");
    const expiry =
      dataValue(record, "expiry_date") ??
      dataValue(record, "expiryDate") ??
      dataValue(record, "expires_at") ??
      dataValue(record, "expiresAt");

    if (accessToken) credentials.access_token = accessToken;
    if (refreshToken) credentials.refresh_token = refreshToken;
    if (idToken) credentials.id_token = idToken;
    if (tokenType) credentials.token_type = tokenType;
    const scopes = dataValue(record, "scopes");
    if (Array.isArray(scopes)) {
      credentials.scope = readScopeArray(scopes, ctx);
    } else if (scope) {
      credentials.scope = scope;
    }

    const expiryDate = parseExpiry(expiry);
    if (expiryDate) credentials.expiry_date = expiryDate;
  } finally {
    ctx.visiting.delete(record);
  }
}
