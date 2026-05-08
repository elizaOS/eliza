import { describe, expect, it } from "vitest";
import { activeSubAgentsProvider } from "../../src/providers/active-sub-agents.js";
import type { SessionInfo } from "../../src/services/types.js";
import {
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

const ROOM = "11111111-2222-3333-4444-555555555555";
const USER = "ffffffff-1111-2222-3333-444444444444";

function sub(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const now = new Date("2026-05-07T12:00:00.000Z");
  return {
    id: "01234567-89ab-cdef-0123-456789abcdef",
    name: "demo",
    agentType: "codex",
    workdir: "/Users/x/work/repo",
    status: "ready",
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata: { label: "demo", roomId: ROOM, userId: USER },
    ...overrides,
  };
}

describe("activeSubAgentsProvider", () => {
  it("returns empty when service is missing", async () => {
    const runtime = runtimeWith(undefined);
    const result = await activeSubAgentsProvider.get(runtime, memory(), state);
    expect(result.text).toBe("");
    expect((result.data as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it("includes only sessions with origin metadata", async () => {
    const sessions = [
      sub({ id: "00000000-aaaa-bbbb-cccc-000000000001", status: "ready" }),
      sub({
        id: "00000000-aaaa-bbbb-cccc-000000000002",
        status: "ready",
        metadata: { label: "no-origin" },
      }),
    ];
    const service = serviceMock({
      listSessions: () => sessions,
    });
    const runtime = runtimeWith(service);
    const result = await activeSubAgentsProvider.get(runtime, memory(), state);
    expect(result.text).toContain("00000000-aaaa-bbbb-cccc-000000000001");
    expect(result.text).not.toContain("00000000-aaaa-bbbb-cccc-000000000002");
    expect(
      (result.data as { sessions: { sessionId: string }[] }).sessions,
    ).toHaveLength(1);
  });

  it("filters out terminal sessions", async () => {
    const sessions = [
      sub({ id: "11111111-aaaa-bbbb-cccc-000000000001", status: "completed" }),
      sub({ id: "11111111-aaaa-bbbb-cccc-000000000002", status: "stopped" }),
      sub({ id: "11111111-aaaa-bbbb-cccc-000000000003", status: "error" }),
      sub({ id: "11111111-aaaa-bbbb-cccc-000000000004", status: "errored" }),
      sub({ id: "11111111-aaaa-bbbb-cccc-000000000005", status: "cancelled" }),
      sub({ id: "11111111-aaaa-bbbb-cccc-000000000006", status: "ready" }),
    ];
    const service = serviceMock({
      listSessions: () => sessions,
    });
    const runtime = runtimeWith(service);
    const result = await activeSubAgentsProvider.get(runtime, memory(), state);
    expect(result.text).toContain("11111111-aaaa-bbbb-cccc-000000000006");
    expect(result.text).not.toContain("000000000001");
    expect(result.text).not.toContain("000000000005");
  });

  it("sorts deterministically by sessionId for cache stability", async () => {
    const sessions = [
      sub({ id: "00000000-bbbb-bbbb-bbbb-000000000003", status: "ready" }),
      sub({ id: "00000000-bbbb-bbbb-bbbb-000000000001", status: "ready" }),
      sub({ id: "00000000-bbbb-bbbb-bbbb-000000000002", status: "ready" }),
    ];
    const service = serviceMock({
      listSessions: () => sessions,
    });
    const runtime = runtimeWith(service);
    const result = await activeSubAgentsProvider.get(runtime, memory(), state);
    const text = result.text ?? "";
    const i1 = text.indexOf("000000000001");
    const i2 = text.indexOf("000000000002");
    const i3 = text.indexOf("000000000003");
    expect(i1).toBeGreaterThan(-1);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  it("excludes volatile fields (timestamps) for cache stability", async () => {
    const sessions = [sub({ status: "ready" })];
    const service = serviceMock({
      listSessions: () => sessions,
    });
    const runtime = runtimeWith(service);
    const result = await activeSubAgentsProvider.get(runtime, memory(), state);
    expect(result.text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(result.text).not.toMatch(/lastActivity/i);
  });

  it("instructs the model on the action choices", async () => {
    const sessions = [sub({ status: "blocked" })];
    const service = serviceMock({
      listSessions: () => sessions,
    });
    const runtime = runtimeWith(service);
    const result = await activeSubAgentsProvider.get(runtime, memory(), state);
    expect(result.text).toContain("SEND_TO_AGENT");
    expect(result.text).toContain("STOP_AGENT");
    expect(result.text).toContain("REPLY");
  });

  it("buckets transient statuses into 'active' for cache stability", async () => {
    const transient = [
      "ready",
      "running",
      "busy",
      "tool_running",
      "authenticating",
    ];
    for (const status of transient) {
      const service = serviceMock({
        listSessions: () => [sub({ status })],
      });
      const runtime = runtimeWith(service);
      const result = await activeSubAgentsProvider.get(
        runtime,
        memory(),
        state,
      );
      expect(result.text).toContain("status=active");
      expect(result.text).not.toContain(`status=${status}`);
    }
  });

  it("preserves 'blocked' status (distinct from 'active' for the planner)", async () => {
    const service = serviceMock({
      listSessions: () => [sub({ status: "blocked" })],
    });
    const runtime = runtimeWith(service);
    const result = await activeSubAgentsProvider.get(runtime, memory(), state);
    expect(result.text).toContain("status=blocked");
  });

  it("renders identical text when only transient status flips occur", async () => {
    const sessionA = sub({ status: "ready" });
    const sessionB = sub({ status: "tool_running" });
    const sessionC = sub({ status: "busy" });
    const runs = [sessionA, sessionB, sessionC].map(async (s) => {
      const service = serviceMock({ listSessions: () => [s] });
      const runtime = runtimeWith(service);
      const result = await activeSubAgentsProvider.get(
        runtime,
        memory(),
        state,
      );
      return result.text;
    });
    const texts = await Promise.all(runs);
    expect(texts[0]).toBe(texts[1]);
    expect(texts[1]).toBe(texts[2]);
  });
});
