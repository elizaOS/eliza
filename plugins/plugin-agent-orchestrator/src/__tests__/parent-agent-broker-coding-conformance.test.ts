/**
 * Exercises the child-to-parent broker failure path through a real PGLite-backed
 * DefaultMessageService, AcpService event stream, and SubAgentRouter. Model I/O
 * is deterministic and local; only the final child-delivery transport is a probe.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Action,
  ChannelType,
  type IAgentRuntime,
  type Memory,
  ModelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { createTestRuntimeWithModelProvider } from "@elizaos/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import {
  PARENT_AGENT_FAILURE_RECEIPT_PREFIX,
  parseParentAgentFailureReceipt,
} from "../services/parent-agent-dispatch.js";
import { SubAgentRouter } from "../services/sub-agent-router.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("parent-agent explicit coding-mode negative conformance", () => {
  it("preserves an unverified real workspace mutation as a typed child receipt", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "parent-broker-coding-"));
    cleanups.push(() => rmSync(workdir, { recursive: true, force: true }));
    const mutatedFile = join(workdir, "parent-mutation.txt");
    let plannerCalls = 0;
    const writeAction: Action = {
      name: "WRITE",
      override: true,
      description: "Write exact text to a file in the isolated test workspace.",
      contexts: ["code", "files"],
      parameters: [
        {
          name: "file_path",
          description: "Workspace-relative file path.",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "content",
          description: "Exact file content.",
          required: true,
          schema: { type: "string" },
        },
      ],
      validate: async () => true,
      handler: async (
        _runtime: IAgentRuntime,
        _message: Memory,
        _state: unknown,
        options: { parameters?: Record<string, unknown> },
      ) => {
        const filePath = String(options.parameters?.file_path ?? "");
        const content = String(options.parameters?.content ?? "");
        if (filePath !== "parent-mutation.txt") {
          throw new Error(`unexpected write path: ${filePath}`);
        }
        writeFileSync(mutatedFile, content, "utf8");
        return {
          success: true,
          text: `wrote ${filePath}`,
          modelReplyRequired: true,
          data: {
            workspaceDeltaReceipt: {
              version: 1,
              kind: "workspace_delta",
              scope: {
                kind: "git_worktree",
                root: workdir,
                rootId: "a".repeat(64),
                executionDomainId: "b".repeat(64),
                coverage: "tracked_and_untracked_nonignored",
              },
              outcome: "changed",
              observedAt: new Date().toISOString(),
            },
          },
        };
      },
    };
    const harness = await createTestRuntimeWithModelProvider({
      characterName: "ParentBrokerConformanceAgent",
      resolve: (call) => {
        if (call.modelType !== ModelType.ACTION_PLANNER) return undefined;
        plannerCalls += 1;
        if (plannerCalls === 1) {
          expect(call.toolNames).toContain("WRITE");
          return {
            text: "",
            toolCalls: [
              {
                id: "write-parent-mutation",
                name: "WRITE",
                args: {
                  file_path: "parent-mutation.txt",
                  content: "mutated but unverified\n",
                },
              },
            ],
          };
        }
        return {
          text: "",
          toolCalls: [
            {
              id: `premature-reply-${plannerCalls}`,
              name: "REPLY",
              args: { text: "The parent coding change is complete." },
            },
          ],
        };
      },
    });
    cleanups.push(harness.cleanup);
    await harness.runtime.disableTrajectories();
    harness.runtime.registerAction(writeAction);
    expect(harness.runtime.actions).toContain(writeAction);

    const roomId = stringToUuid("parent-broker-conformance-room") as UUID;
    const userId = stringToUuid("parent-broker-conformance-user") as UUID;
    const worldId = stringToUuid("parent-broker-conformance-world") as UUID;
    await harness.runtime.createWorld({
      id: worldId,
      name: "Parent broker conformance world",
      agentId: harness.runtime.agentId,
      metadata: { roles: { [userId]: "ADMIN" } },
    });
    await harness.runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "Parent broker child",
      source: "parent-agent-broker",
      channelId: roomId,
      type: ChannelType.DM,
    });

    const session = {
      id: "parent-broker-conformance-session",
      status: "running",
      workdir,
      metadata: { userId, roomId, worldId, source: "parent-agent-broker" },
    };
    const acp = new AcpService(harness.runtime);
    const sent: string[] = [];
    acp.getSession = vi.fn(async () => session as never);
    acp.sendToSession = vi.fn(async (_sessionId: string, input: string) => {
      sent.push(input);
      return {} as never;
    });
    harness.runtime.services.set(AcpService.serviceType, [acp]);
    const router = await SubAgentRouter.start(harness.runtime);
    cleanups.push(() => router.stop());

    const receipts: unknown[] = [];
    acp.onSessionEvent((_sessionId, event, data) => {
      if (event === "parent_agent_failure") receipts.push(data);
    });
    acp.emitSessionEvent(session.id, "message", {
      text: `USE_SKILL parent-agent ${JSON.stringify({
        request:
          "Write parent-mutation.txt with the requested content, then finish without running shell verification.",
        executionMode: "coding",
      })}`,
    });

    await vi.waitFor(
      () => {
        expect(sent).toHaveLength(1);
      },
      { timeout: 20_000 },
    );
    expect(plannerCalls).toBe(3);
    const expectedFailure = {
      kind: "coding_mutation_unverified",
      transient: false,
      message:
        "I changed files but could not complete the required command verification. The coding task is incomplete.",
    };
    expect(readFileSync(mutatedFile, "utf8")).toBe("mutated but unverified\n");
    expect(sent).toHaveLength(1);
    expect(sent[0].startsWith(PARENT_AGENT_FAILURE_RECEIPT_PREFIX)).toBe(true);
    expect(receipts).toHaveLength(1);
    expect(parseParentAgentFailureReceipt(sent[0])).toEqual({
      type: "parent_agent_failure",
      version: 1,
      brokerSuccess: false,
      terminalFailure: expectedFailure,
    });
    expect(receipts[0]).toEqual({
      type: "parent_agent_failure",
      version: 1,
      brokerSuccess: false,
      delivered: true,
      terminalFailure: expectedFailure,
    });
  }, 60_000);
});
