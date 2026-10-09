/** Reclaims completed file trajectories for one agent through the core task clock.
 * Running records, temporary writes, links, and unrelated artifacts are retained.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  ElizaError,
  type IAgentRuntime,
  Service,
  stringToUuid,
  type TaskWorker,
} from "@elizaos/core";
import { resolveTrajectoryDir } from "./trajectory-recorder.ts";

const DAY = 86_400_000;
const WORKER = "TRAJECTORY_FILE_RETENTION";

export function resolveTrajectoryRetentionDays(
  raw = process.env.ELIZA_TRAJECTORY_RETENTION_DAYS,
): number {
  if (raw === undefined) return 14;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new ElizaError(
      "Set ELIZA_TRAJECTORY_RETENTION_DAYS to a nonnegative integer; 0 disables cleanup",
      { code: "TRAJECTORY_RETENTION_CONFIG_INVALID" },
    );
  }
  const days = Number(raw);
  if (!Number.isSafeInteger(days * DAY)) {
    throw new ElizaError("Trajectory retention interval is too large", {
      code: "TRAJECTORY_RETENTION_CONFIG_INVALID",
    });
  }
  return days;
}

export async function sweepAgentTrajectoryFiles(
  root: string,
  agentId: string,
  maxAgeMs: number,
  now = Date.now(),
): Promise<number> {
  if (
    !agentId ||
    path.basename(agentId) !== agentId ||
    agentId === "." ||
    agentId === ".." ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0 ||
    !Number.isFinite(now)
  ) {
    throw new ElizaError(
      "Trajectory retention requires an agent directory and positive age",
      { code: "TRAJECTORY_RETENTION_INPUT_INVALID" },
    );
  }
  const directory = path.join(root, agentId);
  try {
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
      return 0;
    let removed = 0;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^tj-[a-zA-Z0-9-]+\.json$/.test(entry.name))
        continue;
      const file = path.join(directory, entry.name);
      const before = await fs.lstat(file);
      if (!before.isFile() || before.mtimeMs >= now - maxAgeMs) continue;
      const record: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        record === null ||
        typeof record !== "object" ||
        !("agentId" in record) ||
        !("trajectoryId" in record) ||
        !("status" in record) ||
        record.agentId !== agentId ||
        `${record.trajectoryId}.json` !== entry.name ||
        (record.status !== "finished" && record.status !== "errored")
      )
        continue;
      // A concurrent replacement or refresh belongs to its writer.
      const current = await fs.lstat(file);
      if (
        !current.isFile() ||
        current.ino !== before.ino ||
        current.mtimeMs !== before.mtimeMs ||
        current.size !== before.size
      )
        continue;
      await fs.unlink(file);
      removed++;
    }
    return removed;
  } catch (cause) {
    // error-policy:J2 Preserve operational failures; only an absent agent directory is designed-empty.
    if (
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ENOENT" &&
      "path" in cause &&
      cause.path === directory
    )
      return 0;
    throw new ElizaError("Unable to complete trajectory file retention", {
      code: "TRAJECTORY_RETENTION_FAILED",
      cause,
      context: { agentId, directory },
    });
  }
}

export async function installTrajectoryRetention(
  runtime: IAgentRuntime,
): Promise<() => Promise<void>> {
  const days = resolveTrajectoryRetentionDays();
  if (days === 0) return async () => undefined;
  const root = resolveTrajectoryDir();
  let stopping = false;
  let active: Promise<number> | undefined;
  const worker: TaskWorker = {
    name: WORKER,
    async execute() {
      if (stopping) return;
      active ??= sweepAgentTrajectoryFiles(root, runtime.agentId, days * DAY);
      const operation = active;
      try {
        await operation;
      } finally {
        if (active === operation) active = undefined;
      }
    },
  };
  if (runtime.getTaskWorker(WORKER))
    throw new ElizaError("Trajectory retention worker is already registered", {
      code: "TRAJECTORY_RETENTION_ALREADY_REGISTERED",
    });
  const id = stringToUuid(`trajectory-file-retention:${runtime.agentId}`);
  // Persist scheduling before publication so a failed setup leaves no worker behind.
  if (!(await runtime.getTask(id))) {
    await runtime.createTask({
      id,
      name: WORKER,
      agentId: runtime.agentId,
      description: "Remove expired completed file trajectories for this agent",
      tags: ["queue", "repeat"],
      metadata: { updateInterval: 6 * 60 * 60 * 1000 },
    });
  }
  runtime.registerTaskWorker(worker);
  return async () => {
    stopping = true;
    if (runtime.getTaskWorker(WORKER) === worker)
      runtime.unregisterTaskWorker(WORKER);
    await active;
  };
}

/** Owns file cleanup independently of optional SQL trajectory capture. */
export class FileTrajectoryRetentionService extends Service {
  static serviceType = "trajectory_file_retention";
  capabilityDescription =
    "Expires completed file trajectories through the core task clock";
  private stopRetention: (() => Promise<void>) | undefined;

  static async start(
    runtime: IAgentRuntime,
  ): Promise<FileTrajectoryRetentionService> {
    const service = new FileTrajectoryRetentionService(runtime);
    service.stopRetention = await installTrajectoryRetention(runtime);
    return service;
  }

  async stop(): Promise<void> {
    await this.stopRetention?.();
  }
}
