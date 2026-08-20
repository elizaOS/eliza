/**
 * Exercises the swarm coordinator's administrative-stop suppression against
 * the real service (deterministic ACP double, no subprocess): a `stopped`
 * carrying `adminStopReason` is lifecycle plumbing and must not synthesize —
 * and must NOT claim the synthesis dedupe slot, so a later genuine lineage
 * completion still posts. An UNMARKED stop still synthesizes (the #11689
 * never-silent-terminal invariant this suppression must not erode).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { ADMIN_STOP_META_KEY } from "../services/admin-stop-marker.js";
import { SwarmCoordinatorService } from "../services/swarm-coordinator-service.js";

type MetadataPatch = Record<string, unknown>;

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function storedSession(
  id: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    agentType: "codex",
    workdir: "/tmp/orchestrator-admin-stop-test",
    status: "stopped",
    metadata,
  };
}

function makeCoordinatorHarness(sessions: Map<string, unknown>): {
  service: SwarmCoordinatorService;
  emit: (sessionId: string, event: string, data: unknown) => void;
  completions: Array<{ status: string; sessionId: string }>;
} {
  const handlers: Array<
    (sessionId: string, event: string, data: unknown) => void
  > = [];
  const acp = {
    onSessionEvent(
      handler: (sessionId: string, event: string, data: unknown) => void,
    ) {
      handlers.push(handler);
      return () => {};
    },
    getSession: async (sessionId: string) => sessions.get(sessionId),
    updateSessionMetadata: vi.fn(
      async (sessionId: string, patch: MetadataPatch) => {
        const session = sessions.get(sessionId) as
          | { metadata?: Record<string, unknown> }
          | undefined;
        if (session) {
          session.metadata = { ...session.metadata, ...patch };
        }
      },
    ),
  };
  const runtime = {
    getService: (type: string) =>
      type === AcpService.serviceType ? acp : null,
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  const service = new SwarmCoordinatorService(runtime);
  (service as unknown as { bindToAcp: () => void }).bindToAcp();
  const completions: Array<{ status: string; sessionId: string }> = [];
  service.setSwarmCompleteCallback(async (payload) => {
    for (const task of payload.tasks) {
      completions.push({ status: task.status, sessionId: task.sessionId });
    }
  });
  return {
    service,
    emit: (sessionId, event, data) => {
      for (const h of [...handlers]) h(sessionId, event, data);
    },
    completions,
  };
}

describe("administrative-stop suppression", () => {
  it("suppresses a marked stop and does NOT claim the dedupe slot — a later lineage completion still posts", async () => {
    const sessions = new Map<string, unknown>([
      [
        "sess-admin",
        storedSession("sess-admin", { [ADMIN_STOP_META_KEY]: "user_stop" }),
      ],
    ]);
    const { emit, completions } = makeCoordinatorHarness(sessions);

    emit("sess-admin", "stopped", {});
    await flushMicrotasks();
    expect(completions).toEqual([]);

    emit("sess-admin", "task_complete", { response: "done for real" });
    await flushMicrotasks();
    expect(completions).toEqual([
      { status: "completed", sessionId: "sess-admin" },
    ]);
  });

  it("an UNMARKED stop still synthesizes — never-silent-terminal holds", async () => {
    const sessions = new Map<string, unknown>([
      ["sess-crash", storedSession("sess-crash", {})],
    ]);
    const { emit, completions } = makeCoordinatorHarness(sessions);

    emit("sess-crash", "stopped", {});
    await flushMicrotasks();
    expect(completions).toEqual([
      { status: "stopped", sessionId: "sess-crash" },
    ]);
  });
});
