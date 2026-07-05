/**
 * Regression coverage for the ACP scratch-dir disk leak (issue #13773): every
 * isolated spawn mkdirs `<scratchRoot>/task-<sessionId>` and nothing ever
 * reclaimed it. Drives the REAL AcpService teardown (closeSession/stopSession)
 * and the REAL startup GC (gcOrphanedScratchDirs) against a real in-memory
 * session store, with the scratch root pointed at a per-test tmp dir via the
 * production ELIZA_ACP_WORKSPACE_ROOT knob. No subprocesses are spawned.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { InMemorySessionStore } from "../services/session-store.js";
import type { SessionInfo, SessionStatus } from "../services/types.js";
import { isIsolatedScratchDir } from "../services/workspace-lifecycle.js";

function makeRuntime(settings: Record<string, string>): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-0000000acpgc",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: (key: string) => settings[key],
    reportError() {},
  } as never;
}

function makeSession(
  id: string,
  workdir: string,
  status: SessionStatus = "ready",
): SessionInfo {
  const now = new Date();
  return {
    id,
    name: id,
    agentType: "elizaos",
    workdir,
    status,
    approvalPreset: "approve-all",
    createdAt: now,
    lastActivityAt: now,
  };
}

async function makeDirWithFile(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "artifact.txt"), "sub-agent scratch output");
}

describe("ACP scratch-dir reclamation (#13773)", () => {
  let root: string;
  let store: InMemorySessionStore;
  let service: AcpService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "acp-scratch-gc-"));
    store = new InMemorySessionStore();
    // ELIZA_ACP_WORKSPACE_ROOT is the production knob; setting it makes the
    // service's scratch-root set exactly [root] (DEFAULT_WORKDIR_ROOT is
    // excluded when this key is set), so the GC scan is confined to the tmp dir.
    service = new AcpService(makeRuntime({ ELIZA_ACP_WORKSPACE_ROOT: root }), {
      store,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("removes an isolated session's scratch dir on closeSession, and leaves a non-isolated workdir alone", async () => {
    // Owned isolated dir: basename `task-<id>` directly under the scratch root.
    const isolatedId = randomUUID();
    const isolatedDir = join(root, `task-${isolatedId}`);
    await makeDirWithFile(isolatedDir);
    await store.create(makeSession(isolatedId, isolatedDir));

    // Non-isolated workdir: a self-checkout-style dir whose basename is NOT
    // `task-<id>` — the guard must refuse to touch it.
    const selfCheckoutId = randomUUID();
    const selfCheckoutDir = join(root, "my-real-project");
    await makeDirWithFile(selfCheckoutDir);
    await store.create(makeSession(selfCheckoutId, selfCheckoutDir));

    expect(existsSync(isolatedDir)).toBe(true);

    await service.closeSession(isolatedId);
    // stopSession is the public alias; it routes through closeSession.
    await service.stopSession(selfCheckoutId);

    expect(existsSync(isolatedDir)).toBe(false);
    // The non-isolated workdir and its contents survive untouched.
    expect(existsSync(selfCheckoutDir)).toBe(true);
    expect(await readFile(join(selfCheckoutDir, "artifact.txt"), "utf8")).toBe(
      "sub-agent scratch output",
    );
  });

  it("never authorizes removing process.cwd() or a dir outside the scratch roots", () => {
    const id = randomUUID();
    // cwd is refused even if it somehow carried the task basename.
    expect(isIsolatedScratchDir(process.cwd(), id, [root])).toBe(false);
    // A correctly-named dir under an UNlisted root is refused.
    expect(
      isIsolatedScratchDir(join("/some/other/root", `task-${id}`), id, [root]),
    ).toBe(false);
    // A dir whose basename belongs to a DIFFERENT session id is refused.
    expect(
      isIsolatedScratchDir(join(root, `task-${randomUUID()}`), id, [root]),
    ).toBe(false);
    // The exact owned shape is accepted.
    expect(isIsolatedScratchDir(join(root, `task-${id}`), id, [root])).toBe(
      true,
    );
  });

  it("startup GC reclaims orphaned task dirs with no live session while sparing live sessions and non-task dirs", async () => {
    const orphanId = randomUUID();
    const liveId = randomUUID();
    const orphanDir = join(root, `task-${orphanId}`);
    const liveDir = join(root, `task-${liveId}`);
    const realProjectDir = join(root, "checked-out-repo");

    await makeDirWithFile(orphanDir);
    await makeDirWithFile(liveDir);
    await makeDirWithFile(realProjectDir);

    // Only the live session is registered, and it is mid-flight (non-terminal).
    await store.create(makeSession(liveId, liveDir, "running"));

    const removed = await service.gcOrphanedScratchDirs();

    expect(removed).toBe(1);
    expect(existsSync(orphanDir)).toBe(false);
    // Live session's dir is protected.
    expect(existsSync(liveDir)).toBe(true);
    // A non-`task-` dir (a real checkout that happens to sit under the root) is
    // never a GC candidate.
    expect(existsSync(realProjectDir)).toBe(true);
  });

  it("startup GC treats a terminal session's leftover dir as reclaimable (SIGKILL-mid-teardown survivor)", async () => {
    // A session that reached a terminal status but whose dir was never removed
    // (process was SIGKILLed before reclaimSessionScratchDir ran).
    const terminalId = randomUUID();
    const terminalDir = join(root, `task-${terminalId}`);
    await makeDirWithFile(terminalDir);
    await store.create(makeSession(terminalId, terminalDir, "errored"));

    const removed = await service.gcOrphanedScratchDirs();

    expect(removed).toBe(1);
    expect(existsSync(terminalDir)).toBe(false);
  });
});
