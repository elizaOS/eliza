/**
 * Proves successful CLI prompts publish `ready` only after the durable session
 * state is promptable, which is the event-driven inbox flush contract.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { InMemorySessionStore } from "../services/session-store.js";
import type { SessionInfo } from "../services/types.js";

const SESSION_ID = "ready-event-session";

function runtime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    character: { name: "Tester" },
    getSetting: (key: string) =>
      key === "ELIZA_ACP_TRANSPORT" ? "cli" : undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    reportError: vi.fn(),
  } as never;
}

function session(): SessionInfo {
  const now = new Date();
  return {
    id: SESSION_ID,
    name: SESSION_ID,
    agentType: "codex",
    workdir: "/tmp/acp-ready-event",
    status: "ready",
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata: { transportMode: "cli" },
  };
}

describe("AcpService ready event", () => {
  it("emits ready after a successful prompt has updated the session store", async () => {
    const store = new InMemorySessionStore();
    await store.create(session());
    const service = new AcpService(runtime(), { store });
    (
      service as unknown as {
        started: boolean;
        runAcpx: () => Promise<{
          code: number;
          signal: null;
          stderr: string;
          finalText: string;
          stopReason: string;
          durationMs: number;
        }>;
      }
    ).started = true;
    (
      service as unknown as {
        runAcpx: () => Promise<{
          code: number;
          signal: null;
          stderr: string;
          finalText: string;
          stopReason: string;
          durationMs: number;
        }>;
      }
    ).runAcpx = vi.fn(async () => ({
      code: 0,
      signal: null,
      stderr: "",
      finalText: "done",
      stopReason: "end_turn",
      durationMs: 7,
    }));

    let readyState: Promise<SessionInfo | null> | undefined;
    let readyData: unknown;
    service.onSessionEvent((sessionId, event, data) => {
      if (sessionId === SESSION_ID && event === "ready") {
        readyState = store.get(SESSION_ID);
        readyData = data;
      }
    });

    const result = await service.sendPrompt(SESSION_ID, "continue");

    expect(result.stopReason).toBe("end_turn");
    expect(readyState).toBeDefined();
    await expect(readyState).resolves.toMatchObject({ status: "ready" });
    expect(readyData).toEqual({ stopReason: "end_turn", durationMs: 7 });
  });
});
