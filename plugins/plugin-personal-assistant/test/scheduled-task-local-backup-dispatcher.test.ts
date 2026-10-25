/**
 * Covers the production scheduled-task dispatcher's local-backup path against a stubbed
 * agent backup surface. Deterministic.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createProductionScheduledTaskDispatcher } from "../src/lifeops/scheduled-task/runtime-wiring.js";
import {
  getAgentBackupStubStateSnapshot,
  resetAgentBackupStubState,
  setAgentBackupStubState,
} from "./stubs/agent.ts";

describe("scheduled task local backup dispatch", () => {
  beforeEach(() => {
    resetAgentBackupStubState();
    setAgentBackupStubState({
      createdBackup: {
        fileName: "2026-06-29T120000Z.agent-backup.json",
        path: "/tmp/2026-06-29T120000Z.agent-backup.json",
        createdAt: "2026-06-29T12:00:00.000Z",
        agentId: "agent-1",
        stateSha256: "abc123",
        sizeBytes: 4096,
      },
    });
  });

  it("runs the encrypted local backup operation from structural task metadata", async () => {
    const runtime = {
      agentId: "agent-1",
      getService: () => null,
    } as unknown as IAgentRuntime;
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });

    await expect(
      dispatcher.dispatch({
        taskId: "task_backup",
        firedAtIso: "2026-06-29T12:00:00.000Z",
        channelKey: "in_app",
        promptInstructions:
          "This text is not parsed to decide whether backup runs.",
        contextRequest: undefined,
        output: { destination: "memory", persistAs: "task_metadata" },
        metadata: {
          systemOperation: "agent.localBackup",
          backupTarget: "local-file",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      messageId: "agent-backup:2026-06-29T120000Z.agent-backup.json",
    });

    expect(getAgentBackupStubStateSnapshot()).toMatchObject({
      createCalls: 1,
      lastCreateAgentId: "agent-1",
    });
  });
});
