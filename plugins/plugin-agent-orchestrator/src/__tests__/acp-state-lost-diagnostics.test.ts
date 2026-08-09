/**
 * When a mid-flight sub-agent loses its ACP state (process exited without
 * persisting), the service must emit a warn diagnostic carrying the session's
 * identity and the tail of its output buffer BEFORE the buffer is reclaimed —
 * otherwise the crash leaves no forensic trail. Exercises the real
 * `logSubAgentStateLost` path with an in-memory store and a captured logger.
 */
import { describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.ts";
import { InMemorySessionStore } from "../services/session-store.ts";
import type { SessionInfo } from "../services/types.ts";

function makeRuntime(warn: (msg: string, data?: unknown) => void) {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    character: { name: "Tester" },
    getSetting: () => undefined,
    logger: { debug() {}, info() {}, warn, error() {} },
    getService: () => null,
  };
}

function session(id: string): SessionInfo {
  const now = new Date(Date.now() - 5 * 60_000);
  return {
    id,
    name: id,
    agentType: "elizaos",
    workdir: "/home/x/apps/app-thing",
    status: "running",
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    acpxSessionId: "acpx-123",
    pid: 4242,
  } as SessionInfo;
}

describe("AcpService state-lost diagnostics", () => {
  it("logs the session identity and output tail before reclaim", async () => {
    const warn = vi.fn();
    const store = new InMemorySessionStore();
    const s = session("sess-1");
    await store.create(s);
    const svc = new AcpService(makeRuntime(warn) as never, { store });

    // Seed the session's output buffer as a live run would.
    const buffers = (svc as unknown as { outputBuffers: Map<string, string[]> })
      .outputBuffers;
    buffers.set("sess-1", [
      "installing deps\n",
      "vite build...\n",
      "FATAL: heap out of memory\n",
    ]);

    (
      svc as unknown as {
        logSubAgentStateLost: (session: SessionInfo, phase: string) => void;
      }
    ).logSubAgentStateLost(s, "health-check");

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, data] = warn.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toContain("state lost");
    expect(data).toMatchObject({
      phase: "health-check",
      sessionId: "sess-1",
      acpxSessionId: "acpx-123",
      agentType: "elizaos",
      workdir: "/home/x/apps/app-thing",
      pid: 4242,
      outputLines: 3,
    });
    // The crash reason is preserved in the tail.
    expect(String(data.tailOutput)).toContain("heap out of memory");
    // Idle time is computed (~5 min).
    expect(Number(data.idleMs)).toBeGreaterThan(4 * 60_000);
  });

  it("reports no buffered output cleanly when the session produced none", async () => {
    const warn = vi.fn();
    const store = new InMemorySessionStore();
    const s = session("sess-2");
    await store.create(s);
    const svc = new AcpService(makeRuntime(warn) as never, { store });

    (
      svc as unknown as {
        logSubAgentStateLost: (session: SessionInfo, phase: string) => void;
      }
    ).logSubAgentStateLost(s, "send-prompt");

    const [, data] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(data.phase).toBe("send-prompt");
    expect(data.outputLines).toBe(0);
    expect(data.tailOutput).toBe("(no buffered output)");
    expect(data.recentEvents).toEqual([]);
  });

  it("captures the event trail for a mid-tool death with an empty output buffer", async () => {
    const warn = vi.fn();
    const store = new InMemorySessionStore();
    const s = session("sess-3");
    await store.create(s);
    const svc = new AcpService(makeRuntime(warn) as never, { store });

    // A hang mid-tool-call is the common death: the buffer only holds
    // assistant text + terminal tool output, so it stays empty — only the
    // event trail records what the agent was doing.
    svc.emitSessionEvent("sess-3", "ready", {});
    svc.emitSessionEvent("sess-3", "tool_running", {
      toolCall: { title: "bun install --frozen-lockfile" },
    });
    svc.emitSessionEvent("sess-3", "reasoning", {
      text: "waiting for the install to finish before wiring routes",
    });

    (
      svc as unknown as {
        logSubAgentStateLost: (session: SessionInfo, phase: string) => void;
      }
    ).logSubAgentStateLost(s, "health-check");

    const [, data] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(data.tailOutput).toBe("(no buffered output)");
    const events = data.recentEvents as string[];
    expect(events).toHaveLength(3);
    expect(events[0]).toContain("ready");
    expect(events[1]).toContain("tool_running — bun install --frozen-lockfile");
    expect(events[2]).toContain("reasoning — waiting for the install");
  });

  it("ring-caps the trail and degrades hints gracefully on unrecognized payloads", async () => {
    const warn = vi.fn();
    const store = new InMemorySessionStore();
    const s = session("sess-4");
    await store.create(s);
    const svc = new AcpService(makeRuntime(warn) as never, { store });

    // Unrecognized payload shapes must not fabricate a hint.
    svc.emitSessionEvent("sess-4", "message", undefined);
    svc.emitSessionEvent("sess-4", "message", 42);
    svc.emitSessionEvent("sess-4", "message", { unrelated: { deep: true } });
    // Overlong hints are truncated, never dropped.
    svc.emitSessionEvent("sess-4", "message", { text: "x".repeat(500) });
    // Push one past the ring cap; only the newest 15 survive.
    for (let i = 0; i < 12; i++) {
      svc.emitSessionEvent("sess-4", "message", { text: `chunk-${i}` });
    }

    (
      svc as unknown as {
        logSubAgentStateLost: (session: SessionInfo, phase: string) => void;
      }
    ).logSubAgentStateLost(s, "health-check");

    const [, data] = warn.mock.calls[0] as [string, Record<string, unknown>];
    const events = data.recentEvents as string[];
    // 16 emitted, cap 15 → the oldest (first hintless) entry fell off.
    expect(events).toHaveLength(15);
    expect(events[events.length - 1]).toContain("chunk-11");
    // Hintless entries render as bare "<iso> <event>" with no fabricated hint.
    expect(events[0]).toMatch(/ message$/);
    expect(events[1]).toMatch(/ message$/);
    // The overlong hint survived, truncated to the cap.
    const truncated = events[2].split(" — ")[1];
    expect(truncated).toBe("x".repeat(120));
  });

  it("computes idleMs as undefined when the session has no lastActivityAt", async () => {
    const warn = vi.fn();
    const store = new InMemorySessionStore();
    const s = session("sess-5");
    (s as { lastActivityAt?: Date }).lastActivityAt = undefined;
    await store.create(s);
    const svc = new AcpService(makeRuntime(warn) as never, { store });

    (
      svc as unknown as {
        logSubAgentStateLost: (session: SessionInfo, phase: string) => void;
      }
    ).logSubAgentStateLost(s, "health-check");

    const [, data] = warn.mock.calls[0] as [string, Record<string, unknown>];
    // Absent activity must read as "unknown", never a fabricated 0 or NaN.
    expect(data.idleMs).toBeUndefined();
  });
});
