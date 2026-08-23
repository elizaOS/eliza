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

async function writeLock(
  lockPath: string,
  owner: Omit<
    {
      pid: number;
      processIdentity: string | null;
      lockIdentity: string;
      token: string;
      createdAt: number;
      expiresAt: number;
    },
    "lockIdentity"
  >,
): Promise<string> {
  await fs.writeFile(lockPath, "{}", { mode: 0o600, flag: "wx" });
  const identity = await lockIdentity(lockPath);
  await fs.writeFile(
    lockPath,
    JSON.stringify({ ...owner, lockIdentity: identity }),
  );
  return identity;
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

  it("does not retire a live publisher paused past the recovery ceiling", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const publication = barrier();
    const publisher = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: {
        afterLockPublishBeforeCandidateCleanup: publication.hook,
      },
    }).deleteExpired(now);
    await publication.entered;
    const contender = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now + 10_000,
      staleLockMs: 1,
      hardStaleLockMs: 2,
      lockTimeoutMs: 20,
      pollMs: 1,
    }).deleteExpired(now);
    await expect(contender).rejects.toMatchObject({
      code: "INTERACTION_STORE_LOCK_TIMEOUT",
    });

    publication.release();
    await expect(publisher).resolves.toBe(0);
  });

  it("accepts candidate cleanup after observing the two-link window", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const publication = barrier();
    const publisherRelease = barrier();
    const publisher = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: {
        afterLockPublishBeforeCandidateCleanup: publication.hook,
        beforeReleaseRetire: publisherRelease.hook,
      },
    }).deleteExpired(now);
    await publication.entered;

    const candidateValidation = barrier();
    const contender = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 1_000,
      pollMs: 1,
      lockRaceHooks: {
        beforePublicationCandidateValidation: candidateValidation.hook,
      },
    }).deleteExpired(now);
    await candidateValidation.entered;
    publication.release();
    await publisherRelease.entered;
    candidateValidation.release();
    publisherRelease.release();

    await expect(Promise.all([publisher, contender])).resolves.toEqual([0, 0]);
  });

  it("re-observes the lock after a publisher completes and releases inside the two-link read window", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    const publication = barrier();
    const publisher = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: {
        afterLockPublishBeforeCandidateCleanup: publication.hook,
      },
    }).deleteExpired(now);
    await publication.entered;

    const candidateValidation = barrier();
    const contender = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 1_000,
      pollMs: 1,
      lockRaceHooks: {
        beforePublicationCandidateValidation: candidateValidation.hook,
      },
    }).deleteExpired(now);
    await candidateValidation.entered;
    publication.release();
    await expect(publisher).resolves.toBe(0);
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    candidateValidation.release();
    await expect(contender).resolves.toBe(0);
  });

  it("re-observes a successor lock linked inside the two-link read window", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    const publication = barrier();
    const publisher = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: {
        afterLockPublishBeforeCandidateCleanup: publication.hook,
      },
    }).deleteExpired(now);
    await publication.entered;

    const candidateValidation = barrier();
    const contender = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 1_000,
      pollMs: 1,
      lockRaceHooks: {
        beforePublicationCandidateValidation: candidateValidation.hook,
      },
    }).deleteExpired(now);
    await candidateValidation.entered;
    publication.release();
    await expect(publisher).resolves.toBe(0);

    const successorRelease = barrier();
    const successor = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: { beforeReleaseRetire: successorRelease.hook },
    }).deleteExpired(now);
    await successorRelease.entered;
    const successorIdentity = await lockIdentity(lockPath);

    candidateValidation.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await lockIdentity(lockPath)).toBe(successorIdentity);
    successorRelease.release();
    await expect(Promise.all([successor, contender])).resolves.toEqual([0, 0]);
  });

  it("a delayed creator cannot publish over a successor owner", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const oldPublication = barrier();
    const oldCreator = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 30,
      pollMs: 1,
      lockRaceHooks: { beforeLockPublish: oldPublication.hook },
    }).deleteExpired(now);
    await oldPublication.entered;

    const successorRelease = barrier();
    const successor = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: { beforeReleaseRetire: successorRelease.hook },
    });
    const successorTransaction = successor.deleteExpired(now);
    await successorRelease.entered;
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    const successorIdentity = await lockIdentity(lockPath);

    oldPublication.release();
    await expect(oldCreator).rejects.toMatchObject({
      code: "INTERACTION_STORE_LOCK_TIMEOUT",
    });
    expect(await lockIdentity(lockPath)).toBe(successorIdentity);
    successorRelease.release();
    await expect(successorTransaction).resolves.toBe(0);
  });

  it("does not start a transaction when recovery claims after the publish check", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await writeLock(lockPath, {
      pid: 2_000_000_000,
      processIdentity: null,
      token: "dead-owner-before-publish-check",
      createdAt: now - 10_000,
      expiresAt: now - 1,
    });

    const afterCheck = barrier();
    let markPublished: () => void = () => {};
    const published = new Promise<void>((resolve) => {
      markPublished = resolve;
    });
    const creator = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 50,
      pollMs: 1,
      lockRaceHooks: {
        afterTransitionCheckBeforeLockPublish: afterCheck.hook,
        afterLockPublishBeforeCandidateCleanup: async () => markPublished(),
      },
    }).deleteExpired(now);
    const creatorError = creator.then(
      () => undefined,
      (error: unknown) => error,
    );
    await afterCheck.entered;

    const recoveryCleanup = barrier();
    const recoverer = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: {
        beforeTransitionMarkerCleanup: async () => {
          await recoveryCleanup.hook();
          throw new Error("simulated stale-recovery marker cleanup failure");
        },
      },
    }).deleteExpired(now);
    const recovererError = recoverer.then(
      () => undefined,
      (error: unknown) => error,
    );
    await recoveryCleanup.entered;
    afterCheck.release();
    await published;
    recoveryCleanup.release();

    await expect(recovererError).resolves.toMatchObject({
      code: "INTERACTION_STORE_RECOVERY_CLEANUP_FAILED",
      context: { committed: false },
    });
    await expect(creatorError).resolves.toMatchObject({
      code: "INTERACTION_STORE_RECOVERY_REQUIRED",
      context: {
        committed: false,
        lockPath,
        markerPath: `${lockPath}.transition`,
        recovery:
          "Stop all store users, verify lockPath still has lockIdentity and ownerToken, remove markerPath and lockPath, fsync their parent directory, then restart.",
        retrySafeAfterRecovery: true,
      },
    });
    await expect(
      fs.lstat(
        path.join(stateDirectory, "message-interaction-sessions.v1.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans a published lock when owner candidate cleanup fails", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    const store = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: {
        beforeOwnerCandidateCleanup: async () => {
          throw new Error("simulated owner candidate cleanup failure");
        },
      },
    });
    await expect(store.deleteExpired(now)).rejects.toMatchObject({
      code: "INTERACTION_STORE_OWNER_CANDIDATE_CLEANUP_FAILED",
      context: {
        committed: false,
        lockPath,
        markerPath: `${lockPath}.transition`,
        published: true,
        recoveryRequired: false,
        retrySafeAfterRecovery: true,
        retrySafeNow: true,
      },
    });
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.lstat(
        path.join(stateDirectory, "message-interaction-sessions.v1.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("types candidate cleanup failure when an existing lock blocks publication", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    const holderRelease = barrier();
    const holder = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: { beforeReleaseRetire: holderRelease.hook },
    }).deleteExpired(now);
    await holderRelease.entered;
    const holderIdentity = await lockIdentity(lockPath);

    const contender = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 1_000,
      pollMs: 1,
      lockRaceHooks: {
        beforeOwnerCandidateCleanup: async () => {
          throw new Error("simulated owner candidate cleanup failure");
        },
      },
    });
    const failure = await contender.deleteExpired(now).then(
      () => {
        throw new Error("contender must not acquire the held lock");
      },
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: "INTERACTION_STORE_OWNER_CANDIDATE_CLEANUP_FAILED",
      context: {
        committed: false,
        lockPath,
        markerPath: `${lockPath}.transition`,
        published: false,
        recoveryRequired: false,
        retrySafeAfterRecovery: true,
        retrySafeNow: true,
      },
    });
    const candidatePath = (failure as { context: { candidatePath: string } })
      .context.candidatePath;
    expect(candidatePath.startsWith(`${lockPath}.owner-${process.pid}-`)).toBe(
      true,
    );
    expect((failure as { cause?: unknown }).cause).toMatchObject({
      message: "simulated owner candidate cleanup failure",
    });
    expect(await lockIdentity(lockPath)).toBe(holderIdentity);

    holderRelease.release();
    await expect(holder).resolves.toBe(0);
  });

  it("types candidate cleanup failure when a transition marker defers publication", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await fs.mkdir(stateDirectory, { recursive: true });
    await fs.writeFile(
      `${lockPath}.transition`,
      JSON.stringify({
        pid: 2_000_000_000,
        processIdentity: null,
        token: "in-flight-transition",
      }),
      { mode: 0o600 },
    );
    const marker = await fs.readFile(`${lockPath}.transition`, "utf8");
    const store = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 1_000,
      pollMs: 1,
      lockRaceHooks: {
        beforeOwnerCandidateCleanup: async () => {
          throw new Error("simulated owner candidate cleanup failure");
        },
      },
    });
    await expect(store.deleteExpired(now)).rejects.toMatchObject({
      code: "INTERACTION_STORE_OWNER_CANDIDATE_CLEANUP_FAILED",
      context: {
        committed: false,
        lockPath,
        markerPath: `${lockPath}.transition`,
        published: false,
        recoveryRequired: false,
        retrySafeAfterRecovery: true,
        retrySafeNow: true,
      },
    });
    expect(await fs.readFile(`${lockPath}.transition`, "utf8")).toBe(marker);
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.lstat(
        path.join(stateDirectory, "message-interaction-sessions.v1.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
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

  it("marks a visible post-rename sync failure as an ambiguous commit", async () => {
    const stateDirectory = await temporaryDirectory();
    const { store, created, now } = await seed(stateDirectory);
    await store.claimIfCurrent({
      ...bindings,
      reference: created.session.reference,
      replayKey: "replay-sync-failure",
      claimId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      now,
      claimTtlMs: 30_000,
    });
    const failing = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: {
        beforeStateDirectorySync: async () => {
          throw new Error("simulated directory sync failure");
        },
      },
    });
    await expect(
      failing.commitIfClaimed({
        reference: created.session.reference,
        replayKey: "replay-sync-failure",
        claimId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        now,
      }),
    ).rejects.toMatchObject({
      code: "INTERACTION_STORE_COMMIT_AMBIGUOUS",
      context: {
        committed: "unknown",
        reconciliationRequired: true,
        retrySafe: false,
      },
    });
    const reopened = new FileMessageInteractionSessionStore({ stateDirectory });
    await expect(
      reopened.get(created.session.reference),
    ).resolves.toMatchObject({
      consume: {
        state: "committed",
        replayKey: "replay-sync-failure",
      },
    });
  });

  it("marks post-sync directory close failure as committed and non-retryable", async () => {
    const stateDirectory = await temporaryDirectory();
    const { created, now } = await seed(stateDirectory);
    const reference = "abcdefabcdefabcdefabcdefabcdefab";
    const failing = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: {
        afterStateDirectoryClose: async () => {
          throw new Error("simulated directory close failure");
        },
      },
    });
    await expect(
      failing.create({ ...created.session, reference }),
    ).rejects.toMatchObject({
      code: "INTERACTION_STORE_COMMIT_AMBIGUOUS",
      context: {
        committed: true,
        reconciliationRequired: true,
        retrySafe: false,
      },
    });
    const reopened = new FileMessageInteractionSessionStore({ stateDirectory });
    await expect(reopened.get(reference)).resolves.toMatchObject({ reference });
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
    await writeLock(lockPath, {
      pid: 2_000_000_000,
      processIdentity: null,
      token: "dead-owner",
      createdAt: now - 10_000,
      expiresAt: now - 1,
    });
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
    await writeLock(lockPath, {
      pid: process.pid,
      processIdentity: null,
      token: "live-owner",
      createdAt: now - 10_000,
      expiresAt: now - 1,
    });
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

  it("rejects a steady lock hardlink outside the publication candidate", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await writeLock(lockPath, {
      pid: process.pid,
      processIdentity: null,
      token: "hardlinked-owner",
      createdAt: now,
      expiresAt: now + 30_000,
    });
    await fs.link(lockPath, `${lockPath}.unexpected-link`);
    const store = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
    });
    await expect(store.deleteExpired(now)).rejects.toMatchObject({
      code: "UNSAFE_INTERACTION_STORE_LOCK",
    });
  });

  it("recovers an expired lock after the recorded PID is reused", async () => {
    if (process.platform !== "linux") return;
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await writeLock(lockPath, {
      pid: process.pid,
      processIdentity: "different-boot:different-start",
      token: "reused-pid-owner",
      createdAt: now - 10_000,
      expiresAt: now - 1,
    });
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
    await writeLock(lockPath, {
      pid: process.pid,
      processIdentity: null,
      token: "unqualified-owner",
      createdAt: now - 101,
      expiresAt: now - 100,
    });
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
    await fs.writeFile(lockPath, "", { mode: 0o600, flag: "wx" });
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

    // Stay well beyond the ceiling so filesystem timestamp precision cannot
    // turn this into a boundary assertion on platforms with rounded mtimes.
    await fs.utimes(lockPath, new Date(now - 1_000), new Date(now - 1_000));
    // Recovery publishes and fsyncs a transition marker before the retry, so
    // the acquiring store needs a timeout that is not bounded by disk latency.
    const recoverer = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 1_000,
      staleLockMs: 1,
      hardStaleLockMs: 100,
      pollMs: 1,
    });
    await expect(recoverer.deleteExpired(now)).resolves.toBe(0);
  });

  it("fences two delayed stale recoverers from the fresh winner generation", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    const staleIdentity = await writeLock(lockPath, {
      pid: 2_000_000_000,
      processIdentity: null,
      token: "stale-generation",
      createdAt: now - 10_000,
      expiresAt: now - 1,
    });

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
    await writeLock(lockPath, {
      pid: 2_000_000_000,
      processIdentity: null,
      token: "departing-generation",
      createdAt: now - 10_000,
      expiresAt: now - 1,
    });
    const recovererGate = barrier();
    const recovering = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 20,
      pollMs: 1,
      lockRaceHooks: { beforeStaleRetire: recovererGate.hook },
    }).deleteExpired(now);
    await recovererGate.entered;

    await fs.rm(lockPath);
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

  it("fails closed on a transition marker abandoned by a dead owner", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await writeLock(lockPath, {
      pid: 2_000_000_000,
      processIdentity: null,
      token: "dead-lock-owner",
      createdAt: now - 10_000,
      expiresAt: now - 1,
    });
    await fs.writeFile(
      `${lockPath}.transition`,
      JSON.stringify({
        pid: 2_000_000_000,
        processIdentity: null,
        token: "dead-transition-owner",
      }),
      { mode: 0o600 },
    );

    const marker = await fs.readFile(`${lockPath}.transition`, "utf8");
    const store = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 20,
      pollMs: 1,
    });
    await expect(store.deleteExpired(now)).rejects.toMatchObject({
      code: "INTERACTION_STORE_RECOVERY_REQUIRED",
      context: { markerPath: `${lockPath}.transition` },
    });
    expect(await fs.readFile(`${lockPath}.transition`, "utf8")).toBe(marker);
    await expect(
      fs.lstat(
        path.join(stateDirectory, "message-interaction-sessions.v1.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("two contenders leave an abandoned transition marker untouched", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await writeLock(lockPath, {
      pid: 2_000_000_000,
      processIdentity: null,
      token: "dead-lock-owner",
      createdAt: now - 10_000,
      expiresAt: now - 1,
    });
    await fs.writeFile(
      `${lockPath}.transition`,
      JSON.stringify({
        pid: 2_000_000_000,
        processIdentity: null,
        token: "dead-transition-owner",
      }),
      { mode: 0o600 },
    );

    const marker = await fs.readFile(`${lockPath}.transition`, "utf8");
    const first = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 20,
      pollMs: 1,
    }).deleteExpired(now);
    const second = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 20,
      pollMs: 1,
    }).deleteExpired(now);
    await expect(Promise.allSettled([first, second])).resolves.toMatchObject([
      {
        status: "rejected",
        reason: {
          code: "INTERACTION_STORE_RECOVERY_REQUIRED",
          context: { markerPath: `${lockPath}.transition` },
        },
      },
      {
        status: "rejected",
        reason: {
          code: "INTERACTION_STORE_RECOVERY_REQUIRED",
          context: { markerPath: `${lockPath}.transition` },
        },
      },
    ]);
    expect(await fs.readFile(`${lockPath}.transition`, "utf8")).toBe(marker);
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
      code: "INTERACTION_STORE_COMMITTED_RELEASE_FAILED",
      context: {
        committed: true,
        releaseErrorCode: "INTERACTION_STORE_LOCK_LOST",
        retrySafeAfterRecovery: false,
      },
    });
    expect(await lockIdentity(lockPath)).toBe(successorIdentity);
    successorRelease.release();
    await expect(successorTransaction).resolves.toBe(0);
  });

  it("cleans its transition marker when lock unlink fails", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    const store = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: {
        beforeLockUnlink: async () => {
          throw new Error("simulated lock unlink failure");
        },
      },
    });
    await expect(store.deleteExpired(now)).rejects.toMatchObject({
      code: "INTERACTION_STORE_COMMITTED_RELEASE_FAILED",
      context: { committed: true, retrySafeAfterRecovery: false },
    });
    expect(await fs.lstat(lockPath)).toBeDefined();
    await expect(fs.lstat(`${lockPath}.transition`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves lock unlink and marker cleanup failures together", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    const store = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: {
        beforeLockUnlink: async () => {
          throw new Error("primary lock unlink failure");
        },
        beforeTransitionAbortCleanup: async () => {
          throw new Error("secondary marker cleanup failure");
        },
      },
    });
    await expect(store.deleteExpired(now)).rejects.toMatchObject({
      code: "INTERACTION_STORE_COMMITTED_CLEANUP_FAILED",
      context: {
        cleanupError: "secondary marker cleanup failure",
        committed: true,
        lockIdentity: expect.any(String),
        lockPath,
        markerPath: `${lockPath}.transition`,
        ownerToken: expect.any(String),
        recovery:
          "Stop all store users, verify lockPath still has lockIdentity and ownerToken when reported, remove markerPath and lockPath, fsync their parent directory, then restart.",
        releaseErrorCode: "INTERACTION_STORE_RELEASE_CLEANUP_FAILED",
        retrySafeAfterRecovery: false,
      },
    });
    expect(await fs.lstat(lockPath)).toBeDefined();
    expect(await fs.lstat(`${lockPath}.transition`)).toBeDefined();
  });

  it("marks stale-recovery cleanup failure as uncommitted and retryable after recovery", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await writeLock(lockPath, {
      pid: 2_000_000_000,
      processIdentity: null,
      token: "dead-owner-before-operation",
      createdAt: now - 10_000,
      expiresAt: now - 1,
    });
    const store = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: {
        beforeTransitionMarkerCleanup: async () => {
          throw new Error("simulated recovery cleanup failure");
        },
      },
    });
    await expect(store.deleteExpired(now)).rejects.toMatchObject({
      code: "INTERACTION_STORE_RECOVERY_CLEANUP_FAILED",
      context: {
        committed: false,
        markerPath: `${lockPath}.transition`,
        retrySafeAfterRecovery: true,
      },
    });
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.lstat(`${lockPath}.transition`)).toBeDefined();
    await expect(
      fs.lstat(
        path.join(stateDirectory, "message-interaction-sessions.v1.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves validation failure when transition cleanup also fails", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    await writeLock(lockPath, {
      pid: 2_000_000_000,
      processIdentity: null,
      token: "dead-owner-validation-error",
      createdAt: now - 10_000,
      expiresAt: now - 1,
    });
    const store = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: {
        beforeTransitionValidation: async () => {
          throw new Error("primary validation failure");
        },
        beforeTransitionAbortCleanup: async () => {
          throw new Error("secondary marker cleanup failure");
        },
      },
    });
    await expect(store.deleteExpired(now)).rejects.toMatchObject({
      code: "INTERACTION_STORE_RECOVERY_CLEANUP_FAILED",
      cause: { message: "primary validation failure" },
      context: {
        cleanupError: "secondary marker cleanup failure",
        committed: false,
        markerPath: `${lockPath}.transition`,
        retrySafeAfterRecovery: true,
      },
    });
    expect(await fs.lstat(`${lockPath}.transition`)).toBeDefined();
  });

  it("types cleanup failure after transition validation mismatch", async () => {
    const stateDirectory = await temporaryDirectory();
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    const staleIdentity = await writeLock(lockPath, {
      pid: 2_000_000_000,
      processIdentity: null,
      token: "dead-owner-validation-mismatch",
      createdAt: now - 10_000,
      expiresAt: now - 1,
    });
    let replacementIdentity = "";
    const store = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: {
        beforeTransitionValidation: async () => {
          await fs.rename(lockPath, `${lockPath}.retired-${staleIdentity}`);
          replacementIdentity = await writeLock(lockPath, {
            pid: process.pid,
            processIdentity: null,
            token: "replacement-owner",
            createdAt: now,
            expiresAt: now + 30_000,
          });
        },
        beforeTransitionAbortCleanup: async () => {
          throw new Error("mismatch marker cleanup failure");
        },
      },
    });
    await expect(store.deleteExpired(now)).rejects.toMatchObject({
      code: "INTERACTION_STORE_RECOVERY_CLEANUP_FAILED",
      context: {
        cleanupError: "mismatch marker cleanup failure",
        committed: false,
        markerPath: `${lockPath}.transition`,
      },
    });
    expect(await lockIdentity(lockPath)).toBe(replacementIdentity);
    expect(await fs.lstat(`${lockPath}.transition`)).toBeDefined();
  });

  it("reports a committed mutation whose transition cleanup fails", async () => {
    const stateDirectory = await temporaryDirectory();
    const { created, now } = await seed(stateDirectory, { retentionMs: 0 });
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    const filePath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json",
    );
    const failing = new FileMessageInteractionSessionStore({
      stateDirectory,
      retentionMs: 0,
      clock: () => now,
      lockRaceHooks: {
        beforeTransitionMarkerCleanup: async () => {
          throw new Error("simulated transition cleanup failure");
        },
      },
    });
    await expect(
      failing.deleteExpired(Date.parse(created.session.expiresAt)),
    ).rejects.toMatchObject({
      code: "INTERACTION_STORE_COMMITTED_CLEANUP_FAILED",
      message:
        "Interaction transaction committed but lock release failed; do not retry the mutation.",
      context: {
        committed: true,
        markerPath: `${lockPath}.transition`,
        retrySafeAfterRecovery: false,
      },
    });
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.lstat(`${lockPath}.transition`)).toBeDefined();
    const committedState = await fs.readFile(filePath, "utf8");

    const contender = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockTimeoutMs: 20,
      pollMs: 1,
    });
    await expect(
      contender.create({
        ...created.session,
        reference: "fedcba9876543210fedcba9876543210",
      }),
    ).rejects.toMatchObject({
      code: "INTERACTION_STORE_RECOVERY_REQUIRED",
      context: { markerPath: `${lockPath}.transition` },
    });
    expect(await fs.readFile(filePath, "utf8")).toBe(committedState);
  });

  it("preserves structured release recovery beside an operation failure", async () => {
    const stateDirectory = await temporaryDirectory();
    const { created, now } = await seed(stateDirectory);
    const lockPath = path.join(
      stateDirectory,
      "message-interaction-sessions.v1.json.lock",
    );
    const failing = new FileMessageInteractionSessionStore({
      stateDirectory,
      clock: () => now,
      lockRaceHooks: {
        beforeTransitionMarkerCleanup: async () => {
          throw new Error("simulated release cleanup failure");
        },
      },
    });
    await expect(failing.create(created.session)).rejects.toMatchObject({
      code: "INTERACTION_STORE_TRANSACTION_AND_RELEASE_FAILED",
      cause: { code: "MESSAGE_INTERACTION_REFERENCE_COLLISION" },
      context: {
        releaseErrorCode: "INTERACTION_STORE_RELEASE_CLEANUP_FAILED",
        releaseErrorContext: { markerPath: `${lockPath}.transition` },
      },
    });
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
