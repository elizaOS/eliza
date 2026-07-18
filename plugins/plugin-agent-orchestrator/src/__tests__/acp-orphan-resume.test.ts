/**
 * Restart recovery for persisted ACP sessions that were mid-tool when the
 * parent runtime died. The test uses the real AcpService resume scanner and
 * session store, while stubbing the prompt transport so it never launches a
 * live coding-agent process.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { InMemorySessionStore } from "../services/session-store.js";
import type { SessionInfo } from "../services/types.js";

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    character: { name: "Tester" },
    getSetting: (key: string) =>
      key === "ELIZA_ACP_TRANSPORT" ? "native" : undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    reportError: vi.fn(),
  } as never;
}

function busySession(id: string): SessionInfo {
  const now = new Date(Date.now() - 5 * 60_000);
  return {
    id,
    name: id,
    agentType: "claude",
    workdir: "/tmp/acp-orphan-resume",
    status: "tool_running",
    acpxSessionId: `protocol-${id}`,
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata: { label: id },
  };
}

describe("AcpService orphan busy-session resume", () => {
  it("resumes persisted native tool_running sessions with no live client", async () => {
    const store = new InMemorySessionStore();
    await store.create(busySession("orphan-native"));
    const service = new AcpService(makeRuntime(), { store });
    const sendPrompt = vi.spyOn(service, "sendPrompt").mockResolvedValue({
      sessionId: "orphan-native",
      response: "",
      finalText: "",
      stopReason: "end_turn",
      durationMs: 0,
      exitCode: 0,
      signal: null,
    });

    const result = await service.resumeOrphanedBusySessions();

    expect(result).toEqual({ resumed: 1, skipped: 0 });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledWith(
      "orphan-native",
      expect.stringContaining("runtime restart"),
    );
  });

  it("does not duplicate resume when a native client is already attached", async () => {
    const store = new InMemorySessionStore();
    await store.create(busySession("live-native"));
    const service = new AcpService(makeRuntime(), { store });
    (
      service as unknown as { nativeClients: Map<string, unknown> }
    ).nativeClients.set("live-native", {});
    const sendPrompt = vi.spyOn(service, "sendPrompt");

    const result = await service.resumeOrphanedBusySessions();

    expect(result).toEqual({ resumed: 0, skipped: 1 });
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});
