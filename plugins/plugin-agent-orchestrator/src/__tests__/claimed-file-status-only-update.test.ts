/**
 * The claimed-file ledger (#16523) through a PGlite-backed AgentRuntime and the
 * production ACP tool-call path. claude-agent-acp ends a Write or Edit with a
 * `tool_call_update` that carries only the call id, the status and the output:
 * no `kind` and no `rawInput`. The ledger must fold that update into the call
 * it already knows as a write, so the call's last status decides the verdict.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, IAgentRuntime, ServiceClass } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import {
  extractWriteLedger,
  verifyClaimedFiles,
} from "../services/claimed-file-verification.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { createRealTestRuntime } from "./real-runtime.js";

/** The production ACP service with its in-memory session store. start() would
 *  reconcile host scratch directories and arm the health check; this test
 *  only needs the tool-call path. */
class UnstartedAcpService extends AcpService {
  static override async start(runtime: IAgentRuntime): Promise<AcpService> {
    return new UnstartedAcpService(runtime);
  }
}

describe("claimed-file ledger with status-only terminal tool updates", () => {
  let runtime: AgentRuntime;
  let cleanupRuntime: (() => Promise<void>) | undefined;
  let acp: AcpService;
  let service: OrchestratorTaskService;
  let root: string;
  const previousStateDir = process.env.ELIZA_STATE_DIR;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "claimed-file-ledger-"));
    process.env.ELIZA_STATE_DIR = join(root, "state");
    ({ runtime, cleanup: cleanupRuntime } = await createRealTestRuntime({
      characterName: "OrchestratorClaimedFileLedgerTest",
      plugins: [
        {
          name: "orchestrator-claimed-file-ledger-test",
          description: "Registers the production ACP and task services",
          services: [
            UnstartedAcpService as unknown as ServiceClass,
            OrchestratorTaskService as unknown as ServiceClass,
          ],
        },
      ],
    }));
    const loadedAcp = await runtime.getServiceLoadPromise(
      AcpService.serviceType,
    );
    const loadedService = await runtime.getServiceLoadPromise(
      OrchestratorTaskService.serviceType,
    );
    if (
      !(loadedAcp instanceof AcpService) ||
      !(loadedService instanceof OrchestratorTaskService)
    ) {
      throw new Error("Production ACP or orchestrator task service missing");
    }
    acp = loadedAcp;
    service = loadedService;
  }, 60_000);

  afterAll(async () => {
    await cleanupRuntime?.();
    if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = previousStateDir;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function sendUpdate(sessionId: string, update: Record<string, unknown>) {
    acp["handleAcpEvent"](
      { method: "session/update", params: { sessionId, update } },
      sessionId,
      "",
      Date.now(),
      false,
      new Set(),
    );
  }

  /** The update series claude-agent-acp sends for one Write call (its
   *  write-new and edit-rejected scenario snapshots). */
  function writeThroughClaudeAdapter(
    sessionId: string,
    workdir: string,
    path: string,
    status: "completed" | "failed",
  ) {
    const filePath = join(workdir, path);
    sendUpdate(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "toolu_write",
      title: "Preparing file…",
      kind: "edit",
      status: "pending",
      rawInput: {},
      locations: [],
    });
    sendUpdate(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_write",
      title: `Write ${path}`,
      kind: "edit",
      rawInput: { file_path: filePath, content: "export const x = 1;\n" },
      locations: [{ path: filePath }],
    });
    sendUpdate(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_write",
      status,
      rawOutput:
        status === "completed"
          ? `File created successfully at: ${filePath}`
          : "The user doesn't want to proceed with this tool use. The tool use was rejected.",
    });
  }

  async function ledgerVerdictFor(
    status: "completed" | "failed",
  ): Promise<ReturnType<typeof verifyClaimedFiles>> {
    const workdir = mkdtempSync(join(root, "work-"));
    const sessionId = `claude-writer-${status}`;
    const task = await service.createTask({
      title: "Add x",
      goal: "Create src/x.ts",
      acceptanceCriteria: ["src/x.ts exports x"],
    });
    const attached = await service.attachSession(task.id, {
      sessionId,
      agentType: "claude",
      workdir,
      status: "ready",
    });
    expect(attached).toBe(true);

    writeThroughClaudeAdapter(sessionId, workdir, "src/x.ts", status);

    // The task service records each ACP event in the background. Completion
    // folds the session's recorded events in the order they were stored.
    const events = await vi.waitFor(async () => {
      const doc = await service["store"].getTask(task.id);
      const recorded = (doc?.events ?? []).filter(
        (event) => event.sessionId === sessionId,
      );
      expect(
        recorded.filter((event) => event.eventType === "tool_running"),
      ).toHaveLength(3);
      return recorded;
    });
    return verifyClaimedFiles(["src/x.ts"], extractWriteLedger(events));
  }

  it("verifies a claimed file whose write completed", async () => {
    const verdict = await ledgerVerdictFor("completed");

    expect(verdict.ledgerObserved).toBe(true);
    expect(verdict.verifiedClaims).toEqual(["src/x.ts"]);
    expect(verdict.unverifiedClaims).toEqual([]);
  });

  it("reports a claimed file whose write failed as a rejected write", async () => {
    const verdict = await ledgerVerdictFor("failed");

    expect(verdict.verifiedClaims).toEqual([]);
    expect(verdict.unverifiedClaims).toEqual([
      { path: "src/x.ts", reason: "rejected-write" },
    ]);
  });
});
