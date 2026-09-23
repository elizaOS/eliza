/** Exercises retention against real file records and registered task execution.
 * The task storage boundary is an in-memory fixture; filesystem cleanup is real.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime, Task, TaskWorker, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  installTrajectoryRetention,
  resolveTrajectoryRetentionDays,
  sweepAgentTrajectoryFiles,
} from "./trajectory-retention.ts";

const DAY = 86_400_000;
const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
const directories: string[] = [];
const originalRoot = process.env.ELIZA_TRAJECTORY_DIR;
const originalDays = process.env.ELIZA_TRAJECTORY_RETENTION_DAYS;
afterEach(async () => {
  for (const dir of directories.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
  if (originalRoot === undefined) delete process.env.ELIZA_TRAJECTORY_DIR;
  else process.env.ELIZA_TRAJECTORY_DIR = originalRoot;
  if (originalDays === undefined)
    delete process.env.ELIZA_TRAJECTORY_RETENTION_DAYS;
  else process.env.ELIZA_TRAJECTORY_RETENTION_DAYS = originalDays;
});
async function setup() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "trajectory-retention-"),
  );
  directories.push(root);
  await fs.mkdir(path.join(root, agentId));
  return root;
}
async function record(
  root: string,
  name: string,
  status: string,
  age: number,
  owner = agentId,
) {
  const file = path.join(root, agentId, `${name}.json`);
  await fs.writeFile(
    file,
    JSON.stringify({
      agentId: owner,
      trajectoryId: name,
      status,
      stages: [{ text: "complete recorded input" }],
    }),
  );
  await fs.utimes(file, new Date(Date.now() - age), new Date(Date.now() - age));
  return file;
}
describe("trajectory file retention", () => {
  it("deletes only expired terminal records owned by this agent", async () => {
    const root = await setup();
    await record(root, "tj-finished", "finished", 20 * DAY);
    await record(root, "tj-errored", "errored", 20 * DAY);
    await record(root, "tj-running", "running", 20 * DAY);
    await record(root, "tj-recent", "finished", DAY);
    await record(
      root,
      "tj-other",
      "finished",
      20 * DAY,
      "00000000-0000-0000-0000-000000000002",
    );
    await fs.writeFile(
      path.join(root, agentId, "tj-write.json.123.old.tmp"),
      "partial writer data",
    );
    const runningBefore = await fs.readFile(
      path.join(root, agentId, "tj-running.json"),
      "utf8",
    );
    expect(await sweepAgentTrajectoryFiles(root, agentId, 14 * DAY)).toBe(2);
    expect((await fs.readdir(path.join(root, agentId))).sort()).toEqual([
      "tj-other.json",
      "tj-recent.json",
      "tj-running.json",
      "tj-write.json.123.old.tmp",
    ]);
    expect(
      await fs.readFile(path.join(root, agentId, "tj-running.json"), "utf8"),
    ).toBe(runningBefore);
  });
  it("does not follow a linked agent directory or linked trajectory", async () => {
    const root = await setup();
    const target = await record(root, "tj-target", "finished", 20 * DAY);
    await fs.symlink(path.join(root, agentId), path.join(root, "linked"));
    expect(await sweepAgentTrajectoryFiles(root, "linked", DAY)).toBe(0);
    const other = await setup();
    await fs.symlink(target, path.join(other, agentId, "tj-target.json"));
    expect(await sweepAgentTrajectoryFiles(other, agentId, DAY)).toBe(0);
    expect(await fs.readFile(target, "utf8")).toContain(
      "complete recorded input",
    );
  });
  it("accepts an absent directory but exposes corrupt expired records", async () => {
    const root = await setup();
    expect(await sweepAgentTrajectoryFiles(root, "missing", DAY)).toBe(0);
    const file = await record(root, "tj-bad", "finished", 20 * DAY);
    await fs.writeFile(file, "{invalid");
    await fs.utimes(file, new Date(0), new Date(0));
    await expect(
      sweepAgentTrajectoryFiles(root, agentId, DAY),
    ).rejects.toMatchObject({ code: "TRAJECTORY_RETENTION_FAILED" });
    expect(await fs.readFile(file, "utf8")).toBe("{invalid");
  });
  it("rejects malformed configuration instead of silently applying a destructive default", () => {
    expect(resolveTrajectoryRetentionDays("0")).toBe(0);
    expect(resolveTrajectoryRetentionDays("3")).toBe(3);
    for (const value of ["", "3days", "-1", "1.5", "9007199254740991"])
      expect(() => resolveTrajectoryRetentionDays(value)).toThrow();
  });
  it("reuses one durable task and disables its captured worker on stop", async () => {
    const root = await setup();
    process.env.ELIZA_TRAJECTORY_DIR = root;
    process.env.ELIZA_TRAJECTORY_RETENTION_DAYS = "14";
    const tasks = new Map<UUID, Task>();
    const workers = new Map<string, TaskWorker>();
    const runtime = {
      agentId,
      getTask: async (id: UUID) => tasks.get(id),
      createTask: async (task: Task) => {
        if (!task.id) throw new Error("missing task id");
        tasks.set(task.id, task);
        return task.id;
      },
      getTaskWorker: (name: string) => workers.get(name),
      registerTaskWorker: (worker: TaskWorker) =>
        workers.set(worker.name, worker),
      unregisterTaskWorker: (name: string) => workers.delete(name),
    } as unknown as IAgentRuntime;
    const stop = await installTrajectoryRetention(runtime);
    const worker = [...workers.values()][0];
    const task = [...tasks.values()][0];
    await record(root, "tj-first", "finished", 20 * DAY);
    const executing = worker.execute(runtime, {}, task);
    await stop();
    await executing;
    expect(await fs.readdir(path.join(root, agentId))).toEqual([]);
    await record(root, "tj-stopped", "finished", 20 * DAY);
    await worker.execute(runtime, {}, task);
    expect(await fs.readdir(path.join(root, agentId))).toEqual([
      "tj-stopped.json",
    ]);
    const stopAgain = await installTrajectoryRetention(runtime);
    expect(tasks.size).toBe(1);
    await stopAgain();
  });
});
