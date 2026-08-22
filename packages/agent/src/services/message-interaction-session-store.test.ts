/**
 * Real-filesystem verification for the single-host durable interaction store:
 * process contention, crash-safe state, stale-lock recovery, permissions,
 * corruption, symlink rejection, and retention collection.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BUTTON_INTERACTION_PROFILE,
  createConnectorInteractionCapabilityProfile,
  type MessageInteractionClaimContext,
  MessageInteractionSessionAuthority,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { FileMessageInteractionSessionStore } from "./message-interaction-session-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "eliza-interaction-store-"),
  );
  roots.push(root);
  return root;
}

async function lockIdentity(lockPath: string): Promise<string> {
  const entry = await fs.lstat(lockPath);
  return `${entry.dev}-${entry.ino}`;
}

function barrier(): {
  entered: Promise<void>;
  hook: () => Promise<void>;
  release: () => void;
} {
  let markEntered: () => void = () => {};
  let release: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    hook: async () => {
      markEntered();
      await blocked;
    },
    release,
  };
}

const bindings = {
  actorId: "actor-a",
  audience: { kind: "room", id: "room-a" },
  agentId: "agent-a",
  connector: { source: "connector", accountId: "account-a" },
  roomId: "room-a",
  sourceMessageId: "message-a",
};

async function seed(
  stateDirectory: string,
  options: { now?: number; expiresAt?: string; retentionMs?: number } = {},
) {
  const now = options.now ?? Date.parse("2026-08-21T00:00:00.000Z");
  const store = new FileMessageInteractionSessionStore({
    stateDirectory,
    retentionMs: options.retentionMs,
    clock: () => now,
  });
  const authority = new MessageInteractionSessionAuthority(store, {
    clock: () => now,
    referenceFactory: () => "0123456789abcdef0123456789abcdef",
  });
  const profile = createConnectorInteractionCapabilityProfile({
    template: BUTTON_INTERACTION_PROFILE,
    source: "connector",
    accountId: "account-a",
    targetKind: "room",
    targetId: "room-a",
  });
  const created = await authority.create({
    block: {
      kind: "choice",
      id: "choice-a",
      scope: "approval",
      options: [{ value: "approve", label: "Approve" }],
    },
    profile,
    bindings,
    purpose: "approval",
    flow: "native",
    presetResponse: { value: "approve" },
    authorization: {
      decisionId: "decision-a",
      policyRevision: "policy-a",
      decidedAt: "2026-08-20T23:59:00.000Z",
    },
    effect: { kind: "approve" },
    expiresAt: options.expiresAt ?? "2026-08-21T00:10:00.000Z",
  });
  return { store, created, now };
}

function runChild(
  stateDirectory: string,
  contextPath: string,
): Promise<string> {
  const fixture = path.join(
    import.meta.dirname,
    "__fixtures__",
    "message-interaction-claim-child.ts",
  );
  const candidates = [
    (() => {
      try {
        return execFileSync(
          process.platform === "win32" ? "where" : "which",
          ["bun"],
          { encoding: "utf8" },
        )
          .split("\n")
          .find(Boolean);
      } catch {
        // error-policy:J4 the test harness uses an explicit install fallback.
        return undefined;
      }
    })(),
    process.env.BUN_INSTALL
      ? path.join(process.env.BUN_INSTALL, "bin", "bun")
      : undefined,
    path.join(
      os.homedir(),
      ".bun",
      "bin",
      process.platform === "win32" ? "bun.exe" : "bun",
    ),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ];
  const bun = candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate)),
  );
  if (!bun) throw new Error("Bun is required for process contention tests");
  return new Promise((resolve, reject) => {
    const child = spawn(bun, [fixture, stateDirectory, contextPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claim child exited ${code}: ${stderr}`));
    });
  });
}

describe("FileMessageInteractionSessionStore", () => {
  it("serializes claims across independent processes", async () => {
    const stateDirectory = await temporaryDirectory();
    const { created, now } = await seed(stateDirectory);
    const context: MessageInteractionClaimContext = {
      ...bindings,
      reference: created.session.reference,
      replayKey: "replay-a",
      claimId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      now,
      claimTtlMs: 30_000,
    };
    const contextPath = path.join(stateDirectory, "claim.json");
    await fs.writeFile(contextPath, JSON.stringify(context), { mode: 0o600 });
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => runChild(stateDirectory, contextPath)),
    );
    expect(outcomes.filter((outcome) => outcome === "acquired")).toHaveLength(
      1,
    );
    expect(
      outcomes.filter((outcome) => outcome === "in_progress"),
    ).toHaveLength(7);
  });

  it("writes a 0600 regular file and retains state across store instances", async () => {
    const stateDirectory = await temporaryDirectory();
    const { created } = await seed(stateDirectory);
    const filePath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json",
    );
    const stat = await fs.lstat(filePath);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    const reopened = new FileMessageInteractionSessionStore({ stateDirectory });
    expect(await reopened.get(created.session.reference)).toMatchObject({
      reference: created.session.reference,
      consume: { state: "pending" },
    });
  });

  it("fails fast on corruption instead of fabricating an empty store", async () => {
    const stateDirectory = await temporaryDirectory();
    const filePath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json",
    );
    await fs.writeFile(filePath, "{broken", { mode: 0o600 });
    const store = new FileMessageInteractionSessionStore({ stateDirectory });
    await expect(
      store.get("0123456789abcdef0123456789abcdef"),
    ).rejects.toMatchObject({
      code: "CORRUPT_INTERACTION_SESSION_STORE",
    });
    const reference = "0123456789abcdef0123456789abcdef";
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        sessions: { [reference]: { sessionVersion: 1, reference } },
      }),
      { mode: 0o600 },
    );
    await expect(store.get(reference)).rejects.toMatchObject({
      code: "CORRUPT_INTERACTION_SESSION_STORE",
    });
  });

  it("rejects store-file and state-directory symlinks", async () => {
    const targetDirectory = await temporaryDirectory();
    const stateDirectory = await temporaryDirectory();
    const targetFile = path.join(targetDirectory, "target.json");
    await fs.writeFile(targetFile, '{"version":1,"sessions":{}}');
    await fs.symlink(
      targetFile,
      path.join(stateDirectory, "message-interaction-sessions.v1.json"),
    );
    await expect(
      new FileMessageInteractionSessionStore({ stateDirectory }).get("missing"),
    ).rejects.toMatchObject({ code: "UNSAFE_INTERACTION_STORE_PATH" });

    const linkDirectory = `${stateDirectory}-link`;
    roots.push(linkDirectory);
    await fs.symlink(targetDirectory, linkDirectory);
    await expect(
      new FileMessageInteractionSessionStore({
        stateDirectory: linkDirectory,
      }).get("missing"),
    ).rejects.toMatchObject({ code: "UNSAFE_INTERACTION_STORE_PATH" });
  });

  it("rejects hardlinked, over-permissive, and oversized store files", async () => {
    const stateDirectory = await temporaryDirectory();
    const filePath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json",
    );
    await fs.writeFile(filePath, '{"version":1,"sessions":{}}', {
      mode: 0o644,
    });
    await expect(
      new FileMessageInteractionSessionStore({ stateDirectory }).get("missing"),
    ).rejects.toMatchObject({ code: "UNSAFE_INTERACTION_STORE_PATH" });
    await fs.chmod(filePath, 0o600);
    const linked = path.join(stateDirectory, "linked.json");
    await fs.link(filePath, linked);
    await expect(
      new FileMessageInteractionSessionStore({ stateDirectory }).get("missing"),
    ).rejects.toMatchObject({ code: "UNSAFE_INTERACTION_STORE_PATH" });
    await fs.unlink(linked);
    await fs.writeFile(filePath, "x".repeat(65), { mode: 0o600 });
    await expect(
      new FileMessageInteractionSessionStore({
        stateDirectory,
        maxStoreBytes: 64,
      }).get("missing"),
    ).rejects.toMatchObject({
      code: "INTERACTION_SESSION_STORE_LIMIT_EXCEEDED",
    });
  });

  it("rejects a directory swapped to a symlink after initialization", async () => {
    const stateDirectory = await temporaryDirectory();
    const redirectedDirectory = await temporaryDirectory();
    const movedDirectory = `${stateDirectory}-moved`;
    roots.push(movedDirectory);
    const store = new FileMessageInteractionSessionStore({ stateDirectory });
    expect(await store.get("0123456789abcdef0123456789abcdef")).toBeNull();
    await fs.rename(stateDirectory, movedDirectory);
    await fs.symlink(redirectedDirectory, stateDirectory);
    await expect(
      store.get("0123456789abcdef0123456789abcdef"),
    ).rejects.toMatchObject({ code: "UNSAFE_INTERACTION_STORE_PATH" });
    expect(await fs.readdir(redirectedDirectory)).toEqual([]);
  });

  it("recovers an expired lock only when its owner process is dead", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 2_000_000_000,
        processIdentity: null,
        lockIdentity: await lockIdentity(lockPath),
        token: "dead-owner",
        createdAt: now - 10_000,
        expiresAt: now - 1,
      }),
      { mode: 0o600 },
    );
    const { created } = await seed(stateDirectory, { now });
    expect(created.session.reference).toBe("0123456789abcdef0123456789abcdef");
  });

  it("does not steal an expired lease from a live owner", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        processIdentity: null,
        lockIdentity: await lockIdentity(lockPath),
        token: "live-owner",
        createdAt: now - 10_000,
        expiresAt: now - 1,
      }),
      { mode: 0o600 },
    );
    const store = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 10,
      pollMs: 1,
    });
    await expect(store.deleteExpired(now)).rejects.toMatchObject({
      code: "INTERACTION_STORE_LOCK_TIMEOUT",
    });
    expect(await fs.lstat(lockPath)).toBeDefined();
  });

  it("recovers an expired lock after the recorded PID is reused", async () => {
    if (process.platform !== "linux") return;
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        processIdentity: "different-boot:different-start",
        lockIdentity: await lockIdentity(lockPath),
        token: "reused-pid-owner",
        createdAt: now - 10_000,
        expiresAt: now - 1,
      }),
      { mode: 0o600 },
    );
    const { created } = await seed(stateDirectory, { now });
    expect(created.session.reference).toBe("0123456789abcdef0123456789abcdef");
  });

  it("never steals from a live PID when its generation is unavailable", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        processIdentity: null,
        lockIdentity: await lockIdentity(lockPath),
        token: "unqualified-owner",
        createdAt: now - 101,
        expiresAt: now - 100,
      }),
      { mode: 0o600 },
    );
    const store = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      staleLockMs: 1,
      hardStaleLockMs: 100,
      lockTimeoutMs: 10,
      pollMs: 1,
    });
    await expect(store.deleteExpired(now)).rejects.toMatchObject({
      code: "INTERACTION_STORE_LOCK_TIMEOUT",
    });
    expect(await fs.lstat(lockPath)).toBeDefined();
  });

  it("uses the absolute recovery ceiling while a lock owner is unpublished", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.utimes(lockPath, new Date(now - 50), new Date(now - 50));
    const store = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 10,
      staleLockMs: 1,
      hardStaleLockMs: 100,
      pollMs: 1,
    });
    await expect(store.deleteExpired(now)).rejects.toMatchObject({
      code: "INTERACTION_STORE_LOCK_TIMEOUT",
    });

    await fs.utimes(lockPath, new Date(now - 101), new Date(now - 101));
    await expect(store.deleteExpired(now)).resolves.toBe(0);
  });

  it("fences two delayed stale recoverers from the fresh winner generation", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await fs.mkdir(lockPath, { mode: 0o700 });
    const staleIdentity = await lockIdentity(lockPath);
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 2_000_000_000,
        processIdentity: null,
        lockIdentity: staleIdentity,
        token: "stale-generation",
        createdAt: now - 10_000,
        expiresAt: now - 1,
      }),
      { mode: 0o600 },
    );

    let staleObservers = 0;
    let releaseObservers: () => void = () => {};
    const bothObserved = new Promise<void>((resolve) => {
      releaseObservers = resolve;
    });
    let allowRecovery: () => void = () => {};
    const recoveryGate = new Promise<void>((resolve) => {
      allowRecovery = resolve;
    });
    const winnerRelease = barrier();
    let releaseCalls = 0;
    const options = {
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 1_000,
      pollMs: 1,
      lockRaceHooks: {
        beforeStaleRetire: async () => {
          staleObservers += 1;
          if (staleObservers === 2) releaseObservers();
          await recoveryGate;
        },
        beforeReleaseRetire: async () => {
          releaseCalls += 1;
          if (releaseCalls === 1) await winnerRelease.hook();
        },
      },
    };
    const first = new FileMessageInteractionSessionStore(options).deleteExpired(
      now,
    );
    const second = new FileMessageInteractionSessionStore(
      options,
    ).deleteExpired(now);
    await bothObserved;
    allowRecovery();
    await winnerRelease.entered;

    const freshIdentity = await lockIdentity(lockPath);
    expect(freshIdentity).not.toBe(staleIdentity);
    winnerRelease.release();
    await expect(Promise.all([first, second])).resolves.toEqual([0, 0]);
  });

  it("revalidates after an old lock disappears and a successor acquires", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await fs.mkdir(lockPath, { mode: 0o700 });
    const staleIdentity = await lockIdentity(lockPath);
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 2_000_000_000,
        processIdentity: null,
        lockIdentity: staleIdentity,
        token: "departing-generation",
        createdAt: now - 10_000,
        expiresAt: now - 1,
      }),
      { mode: 0o600 },
    );
    const recovererGate = barrier();
    const recovering = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 20,
      pollMs: 1,
      lockRaceHooks: { beforeStaleRetire: recovererGate.hook },
    }).deleteExpired(now);
    await recovererGate.entered;

    await fs.rm(lockPath, { recursive: true });
    const successorRelease = barrier();
    const successor = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: { beforeReleaseRetire: successorRelease.hook },
    });
    const successorTransaction = successor.deleteExpired(now);
    await successorRelease.entered;
    const successorIdentity = await lockIdentity(lockPath);

    recovererGate.release();
    await expect(recovering).rejects.toMatchObject({
      code: "INTERACTION_STORE_LOCK_TIMEOUT",
    });
    expect(await lockIdentity(lockPath)).toBe(successorIdentity);
    successorRelease.release();
    await expect(successorTransaction).resolves.toBe(0);
  });

  it("recovers a transition marker abandoned by a dead lock owner", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await fs.mkdir(lockPath, { mode: 0o700 });
    const identity = await lockIdentity(lockPath);
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 2_000_000_000,
        processIdentity: null,
        lockIdentity: identity,
        token: "dead-lock-owner",
        createdAt: now - 10_000,
        expiresAt: now - 1,
      }),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(lockPath, ".transition"),
      JSON.stringify({
        pid: 2_000_000_000,
        processIdentity: null,
        token: "dead-transition-owner",
      }),
      { mode: 0o600 },
    );

    const store = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 1_000,
      pollMs: 1,
    });
    await expect(store.deleteExpired(now)).resolves.toBe(0);
  });

  it("a delayed release cannot detach a replacement lock generation", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    const oldRelease = barrier();
    const oldStore = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: { beforeReleaseRetire: oldRelease.hook },
    });
    const oldTransaction = oldStore.deleteExpired(now);
    await oldRelease.entered;
    const oldIdentity = await lockIdentity(lockPath);
    await fs.rename(lockPath, `${lockPath}.retired-test-${oldIdentity}`);

    const successorRelease = barrier();
    const successor = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: { beforeReleaseRetire: successorRelease.hook },
    });
    const successorTransaction = successor.deleteExpired(now);
    await successorRelease.entered;
    const successorIdentity = await lockIdentity(lockPath);
    expect(successorIdentity).not.toBe(oldIdentity);

    oldRelease.release();
    await expect(oldTransaction).rejects.toMatchObject({
      code: "INTERACTION_STORE_LOCK_LOST",
    });
    expect(await lockIdentity(lockPath)).toBe(successorIdentity);
    successorRelease.release();
    await expect(successorTransaction).resolves.toBe(0);
  });

  it("collects expired sessions through the explicit retention/GC boundary", async () => {
    const stateDirectory = await temporaryDirectory();
    const { store, created } = await seed(stateDirectory, { retentionMs: 0 });
    expect(
      await store.deleteExpired(Date.parse(created.session.expiresAt)),
    ).toBe(1);
    expect(await store.get(created.session.reference)).toBeNull();
  });

  it("retains terminal outcomes until their explicit collection boundary", async () => {
    const stateDirectory = await temporaryDirectory();
    const { store, created, now } = await seed(stateDirectory, {
      retentionMs: 0,
    });
    const claim = await store.claimIfCurrent({
      ...bindings,
      reference: created.session.reference,
      replayKey: "replay-a",
      claimId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      now,
      claimTtlMs: 1,
    });
    expect(claim.status).toBe("acquired");
    await store.commitIfClaimed({
      reference: created.session.reference,
      replayKey: "replay-a",
      claimId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      now,
    });
    expect(
      await store.listCommitted({ committedBefore: now, limit: 10 }),
    ).toMatchObject([
      {
        reference: created.session.reference,
        consume: { state: "committed", replayKey: "replay-a" },
      },
    ]);
    expect(await store.deleteExpired(now - 1)).toBe(0);
    const reopenedCommitted = new FileMessageInteractionSessionStore({
      stateDirectory,
    });
    expect(
      await reopenedCommitted.get(created.session.reference),
    ).toMatchObject({
      consume: { state: "committed" },
    });
    await reopenedCommitted.reconcileCommitted({
      reference: created.session.reference,
      replayKey: "replay-a",
      now,
      receipt: {
        receiptId: "receipt-a",
        idempotencyKey: "replay-a",
        status: "completed",
        completedAt: new Date(now).toISOString(),
        result: { accepted: true },
      },
    });
    const reopenedCompleted = new FileMessageInteractionSessionStore({
      stateDirectory,
    });
    expect(
      await reopenedCompleted.get(created.session.reference),
    ).toMatchObject({
      consume: {
        state: "completed",
        committedAt: new Date(now).toISOString(),
        receipt: { receiptId: "receipt-a" },
      },
    });
    expect(await reopenedCompleted.deleteExpired(now - 1)).toBe(0);
    expect(await reopenedCompleted.deleteExpired(now)).toBe(1);
    expect(await reopenedCompleted.get(created.session.reference)).toBeNull();
  });

  it("prunes retained completions before enforcing session capacity", async () => {
    const stateDirectory = await temporaryDirectory();
    const { store, created, now } = await seed(stateDirectory);
    await store.claimIfCurrent({
      ...bindings,
      reference: created.session.reference,
      replayKey: "replay-a",
      claimId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      now,
      claimTtlMs: 1,
    });
    await store.commitIfClaimed({
      reference: created.session.reference,
      replayKey: "replay-a",
      claimId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      now,
    });
    await store.completeIfClaimed({
      reference: created.session.reference,
      replayKey: "replay-a",
      claimId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      now,
      receipt: {
        receiptId: "receipt-a",
        idempotencyKey: "replay-a",
        status: "completed",
        completedAt: new Date(now).toISOString(),
        result: { accepted: true },
      },
    });
    const bounded = new FileMessageInteractionSessionStore({
      stateDirectory,
      retentionMs: 0,
      maxSessions: 1,
      clock: () => now + 1,
    });
    const replacement = structuredClone(created.session);
    replacement.reference = "fedcba9876543210fedcba9876543210";
    await expect(bounded.create(replacement)).resolves.toBeUndefined();
    expect(await bounded.get(created.session.reference)).toBeNull();
    expect(await bounded.get(replacement.reference)).toMatchObject({
      consume: { state: "pending" },
    });
  });
});
