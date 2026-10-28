/**
 * A store read that fails inside the ongoing-tasks, rolodex or terminal-bridge
 * provider is reported and the model is told the context is missing, instead
 * of the empty result that means "nothing here". Harness as in
 * conversation-provider-demand.test.ts.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { RelationshipsService } from "@elizaos/plugin-assistant";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { automationTerminalBridgeProvider } from "../src/providers/automation-terminal-bridge.ts";
import { rolodexProvider } from "../src/providers/rolodex.ts";
import { createOngoingTasksProvider } from "../src/providers/tasks.ts";

it("reports a failed store read and tells the model the context is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-providers-empty-"));
  const owner = randomUUID() as UUID;
  const runtime = new AgentRuntime({
    agentId: randomUUID() as UUID,
    character: {
      name: "Probe",
      bio: [],
      settings: { ELIZA_ADMIN_ENTITY_ID: owner },
    },
    logLevel: "fatal",
  });
  const adapter = SQLiteDatabaseAdapter.create(
    join(directory, "agent.sqlite"),
    runtime.agentId,
  );
  runtime.registerDatabaseAdapter(adapter);
  await runtime.initialize({ skipMigrations: true });
  const reported: string[] = [];
  const origReport = runtime.reportError.bind(runtime);
  runtime.reportError = ((
    source: string,
    error: unknown,
    ctx?: Record<string, unknown>,
  ) => {
    reported.push(source);
    return origReport(source, error, ctx);
  }) as typeof runtime.reportError;
  try {
    const roomId = randomUUID() as UUID;
    const worldId = randomUUID() as UUID;
    await runtime.createWorld({
      id: worldId,
      agentId: runtime.agentId,
      name: "w",
      metadata: { roles: { [owner]: "OWNER" }, ownership: { ownerId: owner } },
    });
    await runtime.createEntities([
      { id: owner, agentId: runtime.agentId, names: ["Owner"] },
    ]);
    // Automation room linked to a terminal conversation.
    await runtime.createRoom({
      id: roomId,
      agentId: runtime.agentId,
      worldId,
      source: "web",
      type: "DM" as never,
      name: "automation",
      metadata: {
        webConversation: {
          conversationId: "conv-1",
          scope: "automation-coordinator",
          terminalBridgeConversationId: "term-1",
        },
      },
    });
    const termRoom = stringToUuid("web-conv-term-1") as UUID;
    await runtime.createRoom({
      id: termRoom,
      agentId: runtime.agentId,
      worldId,
      source: "web",
      type: "DM" as never,
      name: "terminal",
    });
    await runtime.createMemory(
      {
        id: randomUUID() as UUID,
        agentId: runtime.agentId,
        entityId: owner,
        roomId: termRoom,
        content: { text: "deploy the fix at 5pm", source: "web" },
        createdAt: Date.now(),
      },
      "messages",
    );
    // A real workbench task (shape used by toWorkbenchTask: tags + metadata)
    await runtime.createTask({
      name: "Renew passport",
      description: "before Friday",
      roomId,
      worldId,
      tags: ["workbench-task"],
      metadata: {},
    } as never);
    await runtime.createTask({
      name: "Morning digest",
      description: "digest",
      roomId,
      worldId,
      tags: ["repeat", "trigger"],
      metadata: {
        trigger: {
          triggerId: "trg-1",
          enabled: true,
          triggerType: "interval",
          intervalMs: 3_600_000,
          displayName: "Morning digest",
          instructions: "Summarize overnight email",
        },
      },
    } as never);

    const message = {
      id: randomUUID() as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId,
      content: { text: "what is on my plate?" },
      createdAt: Date.now(),
    } as Memory;
    const state = { values: {}, data: {}, text: "" };

    // Healthy baseline
    const tasksOk = await createOngoingTasksProvider().get(
      runtime,
      message,
      state,
    );
    const bridgeOk = await automationTerminalBridgeProvider.get(
      runtime,
      message,
      state,
    );

    // Store read fails (e.g. SQLITE_IOERR / closed connection)
    vi.spyOn(adapter, "getTasks").mockRejectedValue(
      new Error("SQLITE_IOERR: disk I/O error"),
    );
    vi.spyOn(runtime, "getMemories").mockRejectedValue(
      new Error("SQLITE_IOERR: disk I/O error"),
    );
    const tasksBroken = await createOngoingTasksProvider().get(
      runtime,
      message,
      state,
    );
    const bridgeBroken = await automationTerminalBridgeProvider.get(
      runtime,
      message,
      state,
    );

    // Rolodex: relationships graph read fails
    const service = (await RelationshipsService.start(
      runtime,
    )) as RelationshipsService;
    runtime.services.set("relationships" as never, [service] as never);
    vi.spyOn(service, "getGraphSnapshot").mockRejectedValue(
      new Error("SQLITE_IOERR: disk I/O error"),
    );
    const rolodexBroken = await rolodexProvider.get(runtime, message, state);

    // Healthy reads still render the real context.
    expect(tasksOk.text).toContain("Renew passport");
    expect(bridgeOk.text).toContain("deploy the fix at 5pm");
    // Failed reads are reported and say so; none of them is the empty result.
    expect(tasksBroken.text).toContain("unavailable");
    expect(tasksBroken.values).toEqual({ tasksUnavailable: true });
    expect(bridgeBroken.text).toContain("unavailable");
    expect(bridgeBroken.values).toEqual({ terminalBridgeUnavailable: true });
    expect(rolodexBroken.text).toContain("unavailable");
    expect(rolodexBroken.values).toEqual({ rolodexUnavailable: true });
    expect(reported).toEqual([
      "OngoingTasksProvider.get",
      "AutomationTerminalBridgeProvider.get",
      "RolodexProvider.get",
    ]);
  } finally {
    await runtime.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
