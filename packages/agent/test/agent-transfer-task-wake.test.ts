/** Encrypted agent transfer preserves pending deadlines through the real SQL
 * wake API and starts fresh destination claims without mutating source tasks. */
import type { UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { exportAgent, importAgent } from "../src/services/agent-export.ts";

it("restores pending wakes atomically and leaves consumed wakes consumed", async () => {
  const fixture = await createTestRuntime({
    characterName: "TransferTaskWake",
  });
  try {
    const runtime = fixture.runtime;
    const deadline = Date.now() + 60_000;
    const metadata = {
      updatedAt: Date.now(),
      updateInterval: 300_000,
      transferMarker: "preserved",
    };
    const pending = await runtime.createTask({
      name: "TRANSFER_PENDING_WAKE",
      agentId: runtime.agentId,
      tags: ["queue", "repeat"],
      metadata,
    });
    await runtime.patchTaskMetadata(pending, { wake: { requestAt: deadline } });
    await runtime.patchTaskMetadata(pending, {
      wake: { requestAt: deadline + 1000 },
    });
    const consumed = await runtime.createTask({
      name: "TRANSFER_CONSUMED_WAKE",
      agentId: runtime.agentId,
      tags: ["queue", "repeat"],
      metadata,
    });
    await runtime.patchTaskMetadata(consumed, {
      wake: { requestAt: deadline },
    });
    await runtime.patchTaskMetadata(consumed, { wake: { consumeRevision: 1 } });
    const before = await runtime.getTask(pending);
    expect(before?.metadata).toMatchObject({
      wakeAt: deadline,
      wakeRevision: 2,
    });

    const password = "task-transfer-test-password";
    const bundle = await exportAgent(runtime, password);
    const imported = await importAgent(runtime, bundle, password);
    expect(imported.success).toBe(true);
    if (!runtime.adapter.withAgentScope) throw Error("Missing scoped adapter");
    const tasks = await runtime.adapter.withAgentScope(
      imported.agentId as UUID,
      (db) => db.getTasks({ agentIds: [imported.agentId as UUID] }),
    );
    const restored = tasks.find(
      (task) => task.name === "TRANSFER_PENDING_WAKE",
    );
    expect(restored?.id).not.toBe(pending);
    expect(restored?.metadata).toMatchObject({
      ...metadata,
      wakeAt: deadline,
      wakeRevision: 1,
    });
    const settled = tasks.find(
      (task) => task.name === "TRANSFER_CONSUMED_WAKE",
    );
    expect(settled?.metadata).toEqual(metadata);
    expect(await runtime.getTask(pending)).toEqual(before);
  } finally {
    await fixture.cleanup();
  }
}, 180_000);
