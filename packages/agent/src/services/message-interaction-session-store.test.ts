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
  const root = await fs.mkdtemp("/private/tmp/eliza-interaction-store-");
  roots.push(root);
  return root;
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

  it("collects expired sessions through the explicit retention/GC boundary", async () => {
    const stateDirectory = await temporaryDirectory();
    const { store, created } = await seed(stateDirectory, { retentionMs: 0 });
    expect(
      await store.deleteExpired(Date.parse(created.session.expiresAt)),
    ).toBe(1);
    expect(await store.get(created.session.reference)).toBeNull();
  });
});
