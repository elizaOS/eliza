/**
 * Colocated coverage for the in-memory LocalSensitiveRequestStore. Drives the
 * real module: TTL clamp, lazy expiry, submit-token lifecycle (missing, expired,
 * replayed, not-pending, invalid, success), missing-id no-ops, cancel after
 * expire, audit redaction, and the 100-event audit bound. No mocks of the store.
 */
import { createHash } from "node:crypto";
import type {
  SensitiveRequestDeliveryPlan,
  SensitiveRequestPolicy,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSensitiveRequestSubmitToken,
  DEFAULT_SENSITIVE_REQUEST_TTL_MS,
  LocalSensitiveRequestStore,
  localSensitiveRequestStore,
  MAX_SENSITIVE_REQUEST_TTL_MS,
  redactLocalSensitiveRequest,
} from "./sensitive-request-store";

const NOW = Date.parse("2026-05-10T12:00:00.000Z");

const POLICY: SensitiveRequestPolicy = {
  actor: "owner_only",
  requirePrivateDelivery: true,
  requireAuthenticatedLink: true,
  allowInlineOwnerAppEntry: true,
  allowPublicLink: false,
  allowDmFallback: true,
  allowTunnelLink: true,
  allowCloudLink: true,
};

const DELIVERY: SensitiveRequestDeliveryPlan = {
  kind: "secret",
  source: "api",
  mode: "inline_owner_app",
  policy: POLICY,
  privateRouteRequired: true,
  publicLinkAllowed: false,
  authenticated: true,
  canCollectValueInCurrentChannel: true,
  reason: "owner-app can collect the secret",
  instruction: "enter the secret in the owner app",
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createInput(
  store: LocalSensitiveRequestStore,
  overrides: {
    ttlMs?: number;
    now?: number;
    callback?: { kind?: string; url?: string; secret?: string };
  } = {},
) {
  return store.create({
    kind: "secret",
    agentId: "agent-local",
    target: { kind: "secret", key: "OPENAI_API_KEY" },
    policy: POLICY,
    delivery: DELIVERY,
    now: overrides.now ?? NOW,
    ttlMs: overrides.ttlMs,
    callback: overrides.callback,
  });
}

describe("TTL constants", () => {
  it("defaults to 15 minutes", () => {
    expect(DEFAULT_SENSITIVE_REQUEST_TTL_MS).toBe(15 * 60 * 1000);
  });

  it("caps TTL at 24 hours", () => {
    expect(MAX_SENSITIVE_REQUEST_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("createSensitiveRequestSubmitToken", () => {
  it("returns unique base64url tokens", () => {
    const a = createSensitiveRequestSubmitToken();
    const b = createSensitiveRequestSubmitToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(a).toHaveLength(43);
  });
});

describe("LocalSensitiveRequestStore", () => {
  it("creates a pending record hashed by SHA-256 of the submit token", () => {
    const store = new LocalSensitiveRequestStore();
    const { record, submitToken } = createInput(store);
    expect(record.status).toBe("pending");
    expect(record.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(record.tokenHash).toBe(sha256Hex(submitToken));
    expect(record.createdAt).toBe("2026-05-10T12:00:00.000Z");
    expect(record.updatedAt).toBe(record.createdAt);
    expect(record.expiresAt).toBe(
      new Date(NOW + DEFAULT_SENSITIVE_REQUEST_TTL_MS).toISOString(),
    );
    expect(JSON.stringify(record)).not.toContain(submitToken);
    expect(record.audit).toEqual([
      {
        action: "created",
        outcome: "success",
        createdAt: "2026-05-10T12:00:00.000Z",
        metadata: {
          kind: "secret",
          deliveryMode: "inline_owner_app",
          source: "api",
        },
      },
    ]);
  });

  it("assigns distinct ids and tokens for two creates", () => {
    const store = new LocalSensitiveRequestStore();
    const first = createInput(store);
    const second = createInput(store);
    expect(first.record.id).not.toBe(second.record.id);
    expect(first.submitToken).not.toBe(second.submitToken);
  });

  it("clamps missing, non-positive, and non-finite TTL to the default", () => {
    const store = new LocalSensitiveRequestStore();
    const missing = createInput(store);
    const zero = createInput(store, { ttlMs: 0 });
    const negative = createInput(store, { ttlMs: -5 });
    const nan = createInput(store, { ttlMs: Number.NaN });
    const inf = createInput(store, { ttlMs: Number.POSITIVE_INFINITY });
    const expected = new Date(
      NOW + DEFAULT_SENSITIVE_REQUEST_TTL_MS,
    ).toISOString();
    expect(missing.record.expiresAt).toBe(expected);
    expect(zero.record.expiresAt).toBe(expected);
    expect(negative.record.expiresAt).toBe(expected);
    expect(nan.record.expiresAt).toBe(expected);
    expect(inf.record.expiresAt).toBe(expected);
  });

  it("floors a fractional TTL and never stores a sub-millisecond expiry", () => {
    const store = new LocalSensitiveRequestStore();
    const half = createInput(store, { ttlMs: 0.5 });
    const floored = createInput(store, { ttlMs: 1999.9 });
    expect(half.record.expiresAt).toBe(new Date(NOW + 1).toISOString());
    expect(floored.record.expiresAt).toBe(new Date(NOW + 1999).toISOString());
  });

  it("caps an oversized TTL at the 24-hour maximum", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store, {
      ttlMs: MAX_SENSITIVE_REQUEST_TTL_MS + 1000,
    });
    expect(record.expiresAt).toBe(
      new Date(NOW + MAX_SENSITIVE_REQUEST_TTL_MS).toISOString(),
    );
  });

  it("honours an in-range TTL", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store, { ttlMs: 5000 });
    expect(record.expiresAt).toBe(new Date(NOW + 5000).toISOString());
  });

  it("returns null for a missing id", () => {
    const store = new LocalSensitiveRequestStore();
    expect(store.get("missing")).toBeNull();
  });

  it("returns the live record for a known id", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store);
    expect(store.get(record.id, NOW)).toBe(record);
  });

  it("lazily expires a pending record at the exact expiresAt instant", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store, { ttlMs: 1000 });
    const expiry = NOW + 1000;
    expect(store.get(record.id, expiry - 1)?.status).toBe("pending");
    const expired = store.get(record.id, expiry);
    expect(expired?.status).toBe("expired");
    expect(expired?.updatedAt).toBe(new Date(expiry).toISOString());
    expect(expired?.audit?.at(-1)).toEqual({
      action: "expired",
      outcome: "success",
      createdAt: new Date(expiry).toISOString(),
      metadata: undefined,
    });
  });

  it("does not expire a non-pending record past expiresAt", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store, { ttlMs: 1000 });
    store.fail(record.id, "boom", NOW);
    expect(store.get(record.id, NOW + 60_000)?.status).toBe("failed");
  });

  it("rejects a missing submit-token check with 404 not_found", () => {
    const store = new LocalSensitiveRequestStore();
    expect(store.checkSubmitToken("missing", "token", NOW)).toEqual({
      ok: false,
      status: 404,
      reason: "not_found",
    });
  });

  it("rejects an expired record with 410 even when the token is wrong", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store, { ttlMs: 1000 });
    expect(store.checkSubmitToken(record.id, "wrong", NOW + 1000)).toEqual({
      ok: false,
      status: 410,
      reason: "expired",
    });
  });

  it("rejects a replayed token with 409 before not_pending", () => {
    const store = new LocalSensitiveRequestStore();
    const { record, submitToken } = createInput(store);
    const consumed = store.consumeSubmitToken(record.id, submitToken, NOW);
    expect(consumed.ok).toBe(true);
    store.fulfill(
      record.id,
      { kind: "secret.set", requestId: record.id },
      NOW + 1,
    );
    expect(store.checkSubmitToken(record.id, submitToken, NOW + 2)).toEqual({
      ok: false,
      status: 409,
      reason: "replayed",
    });
  });

  it("rejects a fulfilled unused token with 409 not_pending", () => {
    const store = new LocalSensitiveRequestStore();
    const { record, submitToken } = createInput(store);
    store.fulfill(record.id, { kind: "secret.set", requestId: record.id }, NOW);
    expect(store.checkSubmitToken(record.id, submitToken, NOW)).toEqual({
      ok: false,
      status: 409,
      reason: "not_pending",
    });
  });

  it("rejects an invalid token with 401 and appends a failure audit", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store);
    const result = store.checkSubmitToken(record.id, "not-the-token", NOW);
    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: "invalid_token",
    });
    expect(record.audit?.at(-1)).toEqual({
      action: "submitted",
      outcome: "failure",
      createdAt: "2026-05-10T12:00:00.000Z",
      metadata: { reason: "invalid_token" },
    });
    expect(record.tokenUsedAt).toBeUndefined();
  });

  it("rejects a stored hash of a different length without throwing", () => {
    const store = new LocalSensitiveRequestStore();
    const { record, submitToken } = createInput(store);
    record.tokenHash = "ab";
    expect(store.checkSubmitToken(record.id, submitToken, NOW)).toEqual({
      ok: false,
      status: 401,
      reason: "invalid_token",
    });
  });

  it("accepts the matching token while the record is pending", () => {
    const store = new LocalSensitiveRequestStore();
    const { record, submitToken } = createInput(store);
    const result = store.checkSubmitToken(record.id, submitToken, NOW);
    expect(result).toEqual({ ok: true, record });
    expect(record.tokenUsedAt).toBeUndefined();
  });

  it("consumeSubmitToken returns the failed check without marking the token used", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store);
    const result = store.consumeSubmitToken(record.id, "wrong", NOW);
    expect(result.ok).toBe(false);
    expect(record.tokenUsedAt).toBeUndefined();
  });

  it("consumeSubmitToken marks the token used and audits success", () => {
    const store = new LocalSensitiveRequestStore();
    const { record, submitToken } = createInput(store);
    const result = store.consumeSubmitToken(record.id, submitToken, NOW + 5);
    expect(result).toEqual({ ok: true, record });
    expect(record.tokenUsedAt).toBe(new Date(NOW + 5).toISOString());
    expect(record.audit?.at(-1)).toEqual({
      action: "submitted",
      outcome: "success",
      createdAt: new Date(NOW + 5).toISOString(),
      metadata: { kind: "secret" },
    });
    expect(store.consumeSubmitToken(record.id, submitToken, NOW + 6)).toEqual({
      ok: false,
      status: 409,
      reason: "replayed",
    });
  });

  it("fulfill is a no-op for a missing id", () => {
    const store = new LocalSensitiveRequestStore();
    store.fulfill("missing", { kind: "secret.set", requestId: "missing" }, NOW);
    expect(store.get("missing", NOW)).toBeNull();
  });

  it("fulfill marks the record fulfilled and redacts secret-looking event keys", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store);
    store.fulfill(
      record.id,
      {
        kind: "secret.set",
        requestId: record.id,
        token: "must-not-persist",
      },
      NOW + 9,
    );
    expect(record.status).toBe("fulfilled");
    expect(record.fulfilledAt).toBe(new Date(NOW + 9).toISOString());
    expect(record.updatedAt).toBe(record.fulfilledAt);
    expect(record.audit?.at(-1)).toEqual({
      action: "fulfilled",
      outcome: "success",
      createdAt: new Date(NOW + 9).toISOString(),
      metadata: {
        event: {
          kind: "secret.set",
          requestId: record.id,
          token: "[redacted]",
        },
      },
    });
  });

  it("fail is a no-op for a missing id", () => {
    const store = new LocalSensitiveRequestStore();
    store.fail("missing", "nope", NOW);
    expect(store.get("missing", NOW)).toBeNull();
  });

  it("fail marks the record failed with the given reason", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store);
    store.fail(record.id, "vault write failed", NOW + 3);
    expect(record.status).toBe("failed");
    expect(record.updatedAt).toBe(new Date(NOW + 3).toISOString());
    expect(record.audit?.at(-1)).toEqual({
      action: "failed",
      outcome: "failure",
      createdAt: new Date(NOW + 3).toISOString(),
      metadata: { reason: "vault write failed" },
    });
  });

  it("cancel returns null for a missing id", () => {
    const store = new LocalSensitiveRequestStore();
    expect(store.cancel("missing", NOW)).toBeNull();
  });

  it("cancel transitions a pending record to canceled", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store);
    const canceled = store.cancel(record.id, NOW + 2);
    expect(canceled).toBe(record);
    expect(record.status).toBe("canceled");
    expect(record.updatedAt).toBe(new Date(NOW + 2).toISOString());
    expect(record.audit?.at(-1)).toEqual({
      action: "canceled",
      outcome: "success",
      createdAt: new Date(NOW + 2).toISOString(),
      metadata: undefined,
    });
  });

  it("cancel leaves a non-pending record unchanged", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store);
    store.fail(record.id, "already failed", NOW);
    const returned = store.cancel(record.id, NOW + 1);
    expect(returned?.status).toBe("failed");
    expect(record.audit?.some((event) => event.action === "canceled")).toBe(
      false,
    );
  });

  it("cancel expires a pending record before deciding not to cancel it", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store, { ttlMs: 1000 });
    const returned = store.cancel(record.id, NOW + 1000);
    expect(returned?.status).toBe("expired");
    expect(record.audit?.some((event) => event.action === "canceled")).toBe(
      false,
    );
  });

  it("appendAudit initialises a missing trail and redacts secret-looking keys", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store);
    record.audit = undefined;
    store.appendAudit(record, {
      action: "manual",
      outcome: "success",
      createdAt: "2026-05-10T12:00:01.000Z",
      metadata: { password: "hunter2", keep: "visible" },
    });
    expect(record.audit).toEqual([
      {
        action: "manual",
        outcome: "success",
        createdAt: "2026-05-10T12:00:01.000Z",
        metadata: { password: "[redacted]", keep: "visible" },
      },
    ]);
    expect(record.updatedAt).toBe("2026-05-10T12:00:01.000Z");
  });

  it("appendAudit keeps only the last 100 events", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store);
    for (let i = 0; i < 100; i += 1) {
      store.appendAudit(record, {
        action: `n${i}`,
        outcome: "success",
        createdAt: new Date(NOW + 2 + i).toISOString(),
      });
    }
    expect(record.audit?.length).toBe(100);
    expect(record.audit?.[0]?.action).toBe("n0");
    expect(record.audit?.[99]?.action).toBe("n99");
  });

  it("reset empties the store", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store);
    store.reset();
    expect(store.get(record.id, NOW)).toBeNull();
  });
});

describe("redactLocalSensitiveRequest", () => {
  it("strips tokenHash and tokenUsedAt and redacts callback plus audit metadata", () => {
    const store = new LocalSensitiveRequestStore();
    const { record, submitToken } = createInput(store, {
      callback: {
        kind: "webhook",
        url: "https://example.invalid/hook",
        secret: "callback-secret",
      },
    });
    store.consumeSubmitToken(record.id, submitToken, NOW);
    const publicRecord = redactLocalSensitiveRequest(record);
    expect(publicRecord).not.toHaveProperty("tokenHash");
    expect(publicRecord).not.toHaveProperty("tokenUsedAt");
    expect(publicRecord.callback).toEqual({
      kind: "webhook",
      url: "https://example.invalid/hook",
      secret: "[redacted]",
    });
    expect(
      publicRecord.audit?.some((event) => event.action === "created"),
    ).toBe(true);
    expect(JSON.stringify(publicRecord)).not.toContain(submitToken);
    expect(JSON.stringify(publicRecord)).not.toContain(record.tokenHash);
  });

  it("leaves an absent callback undefined", () => {
    const store = new LocalSensitiveRequestStore();
    const { record } = createInput(store);
    expect(redactLocalSensitiveRequest(record).callback).toBeUndefined();
  });
});

describe("localSensitiveRequestStore singleton", () => {
  afterEach(() => {
    localSensitiveRequestStore.reset();
  });

  it("is a shared LocalSensitiveRequestStore instance", () => {
    expect(localSensitiveRequestStore).toBeInstanceOf(
      LocalSensitiveRequestStore,
    );
    const { record } = createInput(localSensitiveRequestStore);
    expect(localSensitiveRequestStore.get(record.id, NOW)?.id).toBe(record.id);
  });
});
