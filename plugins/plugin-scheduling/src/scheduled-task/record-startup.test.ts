/** Exercises the actual scheduling plugin service startup on a SQLite-backed AgentRuntime. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, type UUID } from "@elizaos/core";
import {
  SQLiteDatabaseAdapter,
  plugin as sqlitePlugin,
} from "@elizaos/plugin-sqlite";
import { expect, it } from "vitest";
import {
  schedulingPlugin,
  waitForScheduledTaskRunnerService,
} from "../plugin.js";
import { createSchedulingRecordStores } from "./record-store.js";
import { getScheduledTaskRunner } from "./runner-service.js";

it("selects durable record storage during actual runtime service startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scheduling-startup-sqlite-"));
  const agentId = randomUUID() as UUID;
  const path = join(directory, "agent.sqlite");
  const runtime = new AgentRuntime({
    character: {
      id: agentId,
      name: "Synthetic scheduling runtime",
      bio: [],
      settings: { SQLITE_DATABASE_PATH: path },
    },
    plugins: [
      sqlitePlugin,
      {
        ...schedulingPlugin,
        schema: undefined,
        dependencies: [sqlitePlugin.name],
      },
    ],
  });
  let restored: SQLiteDatabaseAdapter | undefined;
  try {
    await runtime.initialize();
    await waitForScheduledTaskRunnerService(runtime);
    const runner = getScheduledTaskRunner(runtime, { agentId });
    const scheduled = await runner.schedule({
      kind: "reminder",
      promptInstructions: "Synthetic durable startup",
      trigger: { kind: "once", atIso: "2099-01-01T00:00:00.000Z" },
      priority: "medium",
      respectsGlobalPause: true,
      source: "user_chat",
      createdBy: "synthetic",
      ownerVisible: true,
      idempotencyKey: "startup-proof",
    });
    await runtime.stop();
    await runtime.adapter.close();
    restored = SQLiteDatabaseAdapter.create(path, agentId);
    await restored.initialize();
    expect(
      (
        await createSchedulingRecordStores(
          restored.recordStore,
          agentId,
        ).store.findByIdempotencyKey("startup-proof")
      )?.taskId,
    ).toBe(scheduled.taskId);
  } finally {
    await runtime.stop();
    if (runtime.adapter) await runtime.adapter.close();
    if (restored) await restored.close();
    await rm(directory, { recursive: true, force: true });
  }
});
