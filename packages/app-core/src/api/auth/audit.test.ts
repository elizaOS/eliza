/**
 * Tests the auth audit emitter (`appendAuditEvent` + `redactMetadata`): events
 * are written to the JSONL audit log and the auth store with token-shaped
 * metadata redacted and user-agents truncated, the JSONL write still happens
 * (and the store error rethrows) when the store fails, the store write is still
 * attempted when the log path can't be created, and the log rotates once it
 * hits the size limit. Uses a real temp `ELIZA_STATE_DIR` and a fake in-memory
 * auth store.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthStore } from "../../services/auth-store";
import {
  AUDIT_LOG_FILENAME,
  AUDIT_LOG_MAX_BYTES,
  AUDIT_LOG_ROTATE_FILENAME,
  appendAuditEvent,
  redactMetadata,
  resolveAuditLogPath,
  resolveAuditLogRotatedPath,
} from "./audit";

interface CapturedAuditEvent {
  id: string;
  ts: number;
  actorIdentityId: string | null;
  ip: string | null;
  userAgent: string | null;
  action: string;
  outcome: "success" | "failure";
  metadata: Record<string, string | number | boolean>;
}

class FakeAuditStore {
  public readonly events: CapturedAuditEvent[] = [];
  public error: Error | null = null;

  async appendAuditEvent(
    event: CapturedAuditEvent,
  ): Promise<CapturedAuditEvent> {
    this.events.push(event);
    if (this.error) throw this.error;
    return event;
  }
}

function asAuthStore(store: FakeAuditStore): AuthStore {
  return store as unknown as AuthStore;
}

function readJsonLines(filePath: string): CapturedAuditEvent[] {
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CapturedAuditEvent);
}

describe("auth audit emitter", () => {
  let stateDir: string;
  let env: { ELIZA_STATE_DIR: string };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-audit-test-"));
    env = { ELIZA_STATE_DIR: stateDir };
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("redacts token-shaped metadata without changing scalar non-secrets", () => {
    expect(
      redactMetadata({
        short: "abc123",
        token: "prefix_sk-abcdefghijklmnopqrstuvwxyz_1234_suffix",
        count: 7,
        enabled: true,
      }),
    ).toEqual({
      short: "abc123",
      token: "<redacted>",
      count: 7,
      enabled: true,
    });
  });

  it("writes matching redacted events to JSONL and the auth store", async () => {
    const store = new FakeAuditStore();
    const userAgent = "A".repeat(250);

    await appendAuditEvent(
      {
        actorIdentityId: "identity-1",
        ip: "203.0.113.12",
        userAgent,
        action: "bootstrap.exchange",
        outcome: "success",
        metadata: {
          secret: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
          attempts: 3,
          allowed: true,
        },
      },
      {
        store: asAuthStore(store),
        env,
        now: () => 123_456,
      },
    );

    const [fileEvent] = readJsonLines(resolveAuditLogPath(env));
    const [dbEvent] = store.events;

    expect(fileEvent).toEqual(dbEvent);
    expect(fileEvent).toMatchObject({
      ts: 123_456,
      actorIdentityId: "identity-1",
      ip: "203.0.113.12",
      userAgent: "A".repeat(200),
      action: "bootstrap.exchange",
      outcome: "success",
      metadata: {
        secret: "<redacted>",
        attempts: 3,
        allowed: true,
      },
    });
    expect(fileEvent.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("still writes JSONL when the auth store write fails and rethrows the store error", async () => {
    const store = new FakeAuditStore();
    store.error = new Error("db unavailable");

    await expect(
      appendAuditEvent(
        {
          actorIdentityId: null,
          ip: null,
          userAgent: null,
          action: "machine-token.rotate",
          outcome: "failure",
          metadata: {},
        },
        {
          store: asAuthStore(store),
          env,
          now: () => 200_000,
        },
      ),
    ).rejects.toThrow("db unavailable");

    expect(readJsonLines(resolveAuditLogPath(env))).toHaveLength(1);
    expect(store.events).toHaveLength(1);
  });

  it("still attempts the auth store write when the JSONL path cannot be created", async () => {
    const store = new FakeAuditStore();
    const badStateDir = path.join(stateDir, "not-a-directory");
    fs.writeFileSync(badStateDir, "file blocks mkdir");

    await expect(
      appendAuditEvent(
        {
          actorIdentityId: "identity-2",
          ip: "198.51.100.20",
          userAgent: "agent",
          action: "owner.bind",
          outcome: "failure",
          metadata: { reason: "denied" },
        },
        {
          store: asAuthStore(store),
          env: { ELIZA_STATE_DIR: badStateDir },
          now: () => 300_000,
        },
      ),
    ).rejects.toThrow();

    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      ts: 300_000,
      action: "owner.bind",
      metadata: { reason: "denied" },
    });
  });

  it("rotates the audit log before appending when it reaches the size limit", async () => {
    const store = new FakeAuditStore();
    const authDir = path.join(stateDir, "auth");
    fs.mkdirSync(authDir, { recursive: true });
    const logPath = path.join(authDir, AUDIT_LOG_FILENAME);
    const original = "x".repeat(AUDIT_LOG_MAX_BYTES);
    fs.writeFileSync(logPath, original);

    await appendAuditEvent(
      {
        actorIdentityId: "identity-3",
        ip: "192.0.2.1",
        userAgent: "agent",
        action: "password.change",
        outcome: "success",
        metadata: {},
      },
      {
        store: asAuthStore(store),
        env,
        now: () => 400_000,
      },
    );

    expect(resolveAuditLogRotatedPath(env)).toBe(
      path.join(authDir, AUDIT_LOG_ROTATE_FILENAME),
    );
    expect(fs.readFileSync(resolveAuditLogRotatedPath(env), "utf8")).toBe(
      original,
    );
    expect(readJsonLines(logPath)).toHaveLength(1);
    expect(store.events).toHaveLength(1);
  });
});
