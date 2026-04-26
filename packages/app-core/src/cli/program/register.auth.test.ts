/**
 * Tests for `milady auth reset` — loopback-only refusal and the
 * filesystem-proof challenge.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDatabaseAdapter,
  DatabaseMigrationService,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import type { DrizzleDatabase } from "@elizaos/plugin-sql/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "../../services/auth-store";
import { runMiladyAuthReset } from "./register.auth";

interface AdapterWithDb {
  db?: unknown;
  initialize?: () => Promise<void>;
  init?: () => Promise<void>;
  close?: () => Promise<void>;
}

interface Harness {
  db: DrizzleDatabase;
  store: AuthStore;
  cleanup: () => Promise<void>;
}

async function open(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "milady-cli-auth-"));
  const adapter = createDatabaseAdapter(
    { dataDir },
    "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
  ) as unknown as AdapterWithDb;
  if (typeof adapter.initialize === "function") await adapter.initialize();
  else if (typeof adapter.init === "function") await adapter.init();
  if (!adapter.db) throw new Error("test harness: adapter has no .db");
  const db = adapter.db as DrizzleDatabase;
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(db);
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();
  return {
    db,
    store: new AuthStore(db),
    cleanup: async () => {
      try {
        await adapter.close?.();
      } catch {
        // best effort
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe("milady auth reset", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await open();
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  it("refuses to run when bound to a non-loopback address", async () => {
    const result = await runMiladyAuthReset({
      env: { ELIZA_API_BIND: "0.0.0.0" },
      store: harness.store,
      proofReader: async () => "ignored",
      log: () => {},
      challenge: "fixed-challenge",
      skipProofCleanup: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_loopback");
  });

  it("times out when the proof file is never written", async () => {
    const result = await runMiladyAuthReset({
      env: { ELIZA_API_BIND: "127.0.0.1" },
      store: harness.store,
      proofReader: async () => null,
      log: () => {},
      challenge: "fixed-challenge",
      skipProofCleanup: true,
      proofPollIntervalMs: 5,
      proofTimeoutMs: 30,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("proof_failed");
  });

  it("succeeds when the proof matches and revokes active sessions", async () => {
    // Seed: identity + session
    await harness.store.createIdentity({
      id: "owner-cli",
      kind: "owner",
      displayName: "alice",
      createdAt: 0,
    });
    await harness.store.createSession({
      id: "sess-cli-1",
      identityId: "owner-cli",
      kind: "browser",
      createdAt: 0,
      lastSeenAt: 0,
      expiresAt: Date.now() + 1_000_000,
      rememberDevice: false,
      csrfSecret: "x",
      ip: null,
      userAgent: null,
      scopes: [],
    });

    const result = await runMiladyAuthReset({
      env: { ELIZA_API_BIND: "127.0.0.1" },
      store: harness.store,
      proofReader: async () => "fixed-challenge",
      log: () => {},
      challenge: "fixed-challenge",
      skipProofCleanup: true,
    });
    expect(result.ok).toBe(true);
    // The session is revoked.
    const found = await harness.store.findSession("sess-cli-1");
    expect(found).toBeNull();
  });

  it("rejects a proof file with mismatched contents", async () => {
    const result = await runMiladyAuthReset({
      env: { ELIZA_API_BIND: "127.0.0.1" },
      store: harness.store,
      proofReader: async () => "wrong-token-content",
      log: () => {},
      challenge: "fixed-challenge",
      skipProofCleanup: true,
      proofPollIntervalMs: 5,
      proofTimeoutMs: 30,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("proof_failed");
  });
});
