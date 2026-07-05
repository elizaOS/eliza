/**
 * Bounded retention for the child-trajectory state dir (#14109). Drives the
 * service's real startup GC (`gcChildTrajectoryDirs`) against a temp state dir
 * of per-task trajectory dirs and asserts that:
 *   - a terminal task's aged dir is reclaimed,
 *   - a recent (possibly not-yet-ingested) dir is preserved even when terminal,
 *   - a live (non-terminal) task's dir is never reclaimed even when aged,
 *   - an orphan dir (no task doc) is reclaimed once aged,
 *   - the retention window is honored (env override respected).
 *
 * Uses the injectable InMemoryTaskStore (real store, no DB); no mock stands in
 * for the code under test. The recorder's on-disk layout (per-task dir with an
 * <agentId>/ subdir of `<trajectoryId>.json` files) is reproduced faithfully.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { InMemoryTaskStore } from "../../src/services/orchestrator-task-store.js";

let stateDir: string;
const prevStateDir = process.env.ELIZA_STATE_DIR;
const prevMaxAge =
  process.env.ELIZA_ORCHESTRATOR_CHILD_TRAJECTORY_GC_MAX_AGE_MS;

function makeRuntime() {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    adapter: undefined,
    databaseAdapter: undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: () => undefined,
    reportError: () => {},
  } as unknown as Parameters<typeof OrchestratorTaskService>[0];
}

/** The service's private per-task dir helper — the single source of truth for
 *  where the recorder writes, so the test can't drift from production layout. */
function childTrajectoryDir(
  svc: OrchestratorTaskService,
  taskId: string,
): string {
  return (
    svc as unknown as { childTrajectoryDir: (t: string) => string }
  ).childTrajectoryDir(taskId);
}

function gc(svc: OrchestratorTaskService): Promise<void> {
  return (
    svc as unknown as { gcChildTrajectoryDirs: () => Promise<void> }
  ).gcChildTrajectoryDirs();
}

/** Write a `<trajectoryId>.json` under the task's dir (nested <agentId>/ subdir,
 *  matching the recorder) and set the whole tree's mtime to `ageMs` in the past. */
async function writeTrajectory(
  svc: OrchestratorTaskService,
  taskId: string,
  name: string,
  ageMs: number,
): Promise<void> {
  const dir = join(childTrajectoryDir(svc, taskId), "child-agent");
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ trajectoryId: name }));
  const when = new Date(Date.now() - ageMs);
  // Backdate the file, the <agentId>/ subdir, and the per-task dir so the
  // newest-mtime age gate sees the intended age.
  await utimes(file, when, when);
  await utimes(dir, when, when);
  await utimes(childTrajectoryDir(svc, taskId), when, when);
}

async function makeTask(
  store: InMemoryTaskStore,
  status?: string,
): Promise<string> {
  const doc = await store.createTask({ title: "t", goal: "do the thing" });
  if (status) {
    await store.updateTask(doc.task.id, {
      status: status as never,
    });
  }
  return doc.task.id;
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "orch-traj-gc-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
  if (prevMaxAge === undefined)
    delete process.env.ELIZA_ORCHESTRATOR_CHILD_TRAJECTORY_GC_MAX_AGE_MS;
  else
    process.env.ELIZA_ORCHESTRATOR_CHILD_TRAJECTORY_GC_MAX_AGE_MS = prevMaxAge;
});

describe("gcChildTrajectoryDirs (#14109)", () => {
  it("reclaims an aged terminal task's dir but preserves a recent un-ingested one", async () => {
    const store = new InMemoryTaskStore();
    const svc = new OrchestratorTaskService(makeRuntime(), { store });

    // Aged + terminal → reclaimed. 25h > the 24h default window.
    const agedDone = await makeTask(store, "done");
    await writeTrajectory(svc, agedDone, "aged.json", 25 * 60 * 60_000);

    // Terminal but RECENT (10 min old) → preserved. This is the "never delete a
    // not-yet-ingested trajectory" guarantee: a just-completed task whose files
    // may still be mid-ingest must survive the sweep.
    const recentDone = await makeTask(store, "done");
    await writeTrajectory(svc, recentDone, "recent.json", 10 * 60_000);

    await gc(svc);

    expect(existsSync(childTrajectoryDir(svc, agedDone))).toBe(false);
    expect(existsSync(childTrajectoryDir(svc, recentDone))).toBe(true);
  });

  it("never reclaims a live (non-terminal) task's dir even when aged", async () => {
    const store = new InMemoryTaskStore();
    const svc = new OrchestratorTaskService(makeRuntime(), { store });

    // Live task (status "open"), dir aged well past the window: a long-running
    // task is still producing trajectories under this dir — must be kept.
    const live = await makeTask(store); // default "open" (non-terminal)
    await writeTrajectory(svc, live, "still-writing.json", 48 * 60 * 60_000);

    await gc(svc);

    expect(existsSync(childTrajectoryDir(svc, live))).toBe(true);
  });

  it("reclaims an aged orphan dir with no owning task doc", async () => {
    const store = new InMemoryTaskStore();
    const svc = new OrchestratorTaskService(makeRuntime(), { store });

    // No task doc for this id (task was purged/never persisted) → orphan.
    const orphanId = "orphan-task-id";
    await writeTrajectory(svc, orphanId, "orphan.json", 30 * 60 * 60_000);

    await gc(svc);

    expect(existsSync(childTrajectoryDir(svc, orphanId))).toBe(false);
  });

  it("preserves a recent orphan dir (a brand-new task's doc may not have landed)", async () => {
    const store = new InMemoryTaskStore();
    const svc = new OrchestratorTaskService(makeRuntime(), { store });

    const orphanId = "fresh-orphan-id";
    await writeTrajectory(svc, orphanId, "fresh.json", 5 * 60_000);

    await gc(svc);

    expect(existsSync(childTrajectoryDir(svc, orphanId))).toBe(true);
  });

  it("honors the retention window override (bound respected)", async () => {
    const store = new InMemoryTaskStore();
    const svc = new OrchestratorTaskService(makeRuntime(), { store });

    // Shrink the window to 1h via env; a 2h-old terminal dir now ages out.
    process.env.ELIZA_ORCHESTRATOR_CHILD_TRAJECTORY_GC_MAX_AGE_MS = String(
      60 * 60_000,
    );

    const shortDone = await makeTask(store, "done");
    await writeTrajectory(svc, shortDone, "twohr.json", 2 * 60 * 60_000);

    // A 30-min-old dir stays inside the shrunk window → preserved.
    const insideWindow = await makeTask(store, "done");
    await writeTrajectory(svc, insideWindow, "halfhr.json", 30 * 60_000);

    await gc(svc);

    expect(existsSync(childTrajectoryDir(svc, shortDone))).toBe(false);
    expect(existsSync(childTrajectoryDir(svc, insideWindow))).toBe(true);
  });

  it("is a no-op (no throw) when the trajectories root does not exist", async () => {
    const store = new InMemoryTaskStore();
    const svc = new OrchestratorTaskService(makeRuntime(), { store });
    // Nothing written; the root dir was never created.
    await expect(gc(svc)).resolves.toBeUndefined();
  });
});
