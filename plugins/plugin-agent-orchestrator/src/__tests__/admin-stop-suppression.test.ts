/**
 * Exercises the swarm coordinator's administrative-stop suppression against
 * the real service (deterministic ACP double, no subprocess): a `stopped`
 * carrying a FRESH `adminStopReason` stamp is lifecycle plumbing and must not
 * synthesize — without claiming the synthesis dedupe slot, so a later genuine
 * lineage completion still posts, and repeatedly, so duplicate teardown
 * `stopped` events from one admin action stay quiet. A STALE stamp (past the
 * freshness TTL, or timestamp-less as pre-#22981 stamps are) belongs to an
 * administrative stop that failed to tear the session down; its survivor's
 * genuine crash must synthesize and the marker must be cleared (#22981). An
 * UNMARKED stop still synthesizes (the #11689 never-silent-terminal invariant
 * this suppression must not erode).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import {
  ADMIN_STOP_MARKER_TTL_MS,
  ADMIN_STOP_META_KEY,
  ADMIN_STOP_STAMPED_AT_META_KEY,
} from "../services/admin-stop-marker.js";
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

function freshStamp(reason: string): Record<string, unknown> {
  return {
    [ADMIN_STOP_META_KEY]: reason,
    [ADMIN_STOP_STAMPED_AT_META_KEY]: new Date().toISOString(),
  };
}

function staleStamp(reason: string): Record<string, unknown> {
  return {
    [ADMIN_STOP_META_KEY]: reason,
    [ADMIN_STOP_STAMPED_AT_META_KEY]: new Date(
      Date.now() - ADMIN_STOP_MARKER_TTL_MS - 60_000,
    ).toISOString(),
  };
}

function makeCoordinatorHarness(sessions: Map<string, unknown>): {
  service: SwarmCoordinatorService;
  emit: (sessionId: string, event: string, data: unknown) => void;
  completions: Array<{ status: string; sessionId: string }>;
  updateSessionMetadata: ReturnType<typeof vi.fn>;
} {
  const handlers: Array<
    (sessionId: string, event: string, data: unknown) => void
  > = [];
  const updateSessionMetadata = vi.fn(
    async (sessionId: string, patch: MetadataPatch) => {
      const session = sessions.get(sessionId) as
        | { metadata?: Record<string, unknown> }
        | undefined;
      if (session) {
        session.metadata = { ...session.metadata, ...patch };
      }
    },
  );
  const acp = {
    onSessionEvent(
      handler: (sessionId: string, event: string, data: unknown) => void,
    ) {
      handlers.push(handler);
      return () => {};
    },
    getSession: async (sessionId: string) => sessions.get(sessionId),
    updateSessionMetadata,
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
    updateSessionMetadata,
  };
}

describe("administrative-stop suppression", () => {
  it("suppresses a freshly marked stop and does NOT claim the dedupe slot — a later lineage completion still posts", async () => {
    const sessions = new Map<string, unknown>([
      ["sess-admin", storedSession("sess-admin", freshStamp("user_stop"))],
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

  it("keeps suppressing duplicate teardown stopped events while the stamp is fresh", async () => {
    const sessions = new Map<string, unknown>([
      ["sess-dup", storedSession("sess-dup", freshStamp("task_lifecycle"))],
    ]);
    const { emit, completions, updateSessionMetadata } =
      makeCoordinatorHarness(sessions);

    emit("sess-dup", "stopped", {});
    await flushMicrotasks();
    emit("sess-dup", "stopped", {});
    await flushMicrotasks();

    expect(completions).toEqual([]);
    // A fresh marker is left in place for the duplicate; nothing cleared it.
    expect(updateSessionMetadata).not.toHaveBeenCalled();
  });

  it("a STALE stamp does not silence the survivor's genuine crash — it synthesizes and the marker is cleared", async () => {
    const sessions = new Map<string, unknown>([
      [
        "sess-survivor",
        storedSession("sess-survivor", staleStamp("user_stop")),
      ],
    ]);
    const { emit, completions, updateSessionMetadata } =
      makeCoordinatorHarness(sessions);

    emit("sess-survivor", "stopped", {});
    await flushMicrotasks();

    expect(completions).toEqual([
      { status: "stopped", sessionId: "sess-survivor" },
    ]);
    expect(updateSessionMetadata).toHaveBeenCalledWith("sess-survivor", {
      [ADMIN_STOP_META_KEY]: null,
      [ADMIN_STOP_STAMPED_AT_META_KEY]: null,
    });
  });

  it("a timestamp-less (pre-#22981) stamp is stale — the stop synthesizes", async () => {
    const sessions = new Map<string, unknown>([
      [
        "sess-legacy",
        storedSession("sess-legacy", { [ADMIN_STOP_META_KEY]: "user_stop" }),
      ],
    ]);
    const { emit, completions } = makeCoordinatorHarness(sessions);

    emit("sess-legacy", "stopped", {});
    await flushMicrotasks();

    expect(completions).toEqual([
      { status: "stopped", sessionId: "sess-legacy" },
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
