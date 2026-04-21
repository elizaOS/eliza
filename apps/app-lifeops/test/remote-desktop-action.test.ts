import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/lifeops/remote-desktop.js", () => ({
  startRemoteSession: vi.fn(async () => ({
    id: "abc",
    backend: "tailscale-vnc" as const,
    status: "active" as const,
    accessUrl: "vnc://host:5900",
    accessCode: "123456",
    startedAt: "2025-01-01T00:00:00Z",
    expiresAt: "2025-01-01T01:00:00Z",
  })),
  getSessionStatus: vi.fn(async () => ({
    id: "abc",
    backend: "tailscale-vnc" as const,
    status: "active" as const,
    startedAt: "2025-01-01T00:00:00Z",
  })),
  endRemoteSession: vi.fn(async () => undefined),
  listActiveSessions: vi.fn(async () => [
    {
      id: "s1",
      backend: "tailscale-vnc" as const,
      status: "active" as const,
      startedAt: "2025-01-01T00:00:00Z",
    },
  ]),
  detectRemoteDesktopBackend: vi.fn(async () => "tailscale-vnc" as const),
}));

import { remoteDesktopAction } from "../src/actions/remote-desktop.js";
import {
  startRemoteSession,
  getSessionStatus,
  endRemoteSession,
  listActiveSessions,
} from "../src/lifeops/remote-desktop.js";

const SAME_ID = "00000000-0000-0000-0000-000000000001";

function makeRuntime() {
  return { agentId: SAME_ID } as unknown as Parameters<
    NonNullable<typeof remoteDesktopAction.handler>
  >[0];
}

function makeMessage() {
  return {
    entityId: SAME_ID,
    roomId: "00000000-0000-0000-0000-000000000002",
    content: { text: "remote" },
  } as unknown as Parameters<
    NonNullable<typeof remoteDesktopAction.handler>
  >[1];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("remoteDesktopAction", () => {
  test("start without confirmed=true returns confirmation prompt", async () => {
    const result = await remoteDesktopAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "start" } },
    );
    const r = result as {
      success: boolean;
      text: string;
      values?: { requiresConfirmation?: boolean };
    };
    expect(r.success).toBe(false);
    expect(r.values?.requiresConfirmation).toBe(true);
    expect(r.text.toLowerCase()).toContain("confirm");
    expect(startRemoteSession).not.toHaveBeenCalled();
  });

  test("start with confirmed=true invokes startRemoteSession", async () => {
    const result = await remoteDesktopAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "start", confirmed: true } },
    );
    const r = result as { success: boolean; values?: { sessionId?: string } };
    expect(r.success).toBe(true);
    expect(r.values?.sessionId).toBe("abc");
    expect(startRemoteSession).toHaveBeenCalledTimes(1);
  });

  test("status subaction returns the current session", async () => {
    const result = await remoteDesktopAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "status", sessionId: "abc" } },
    );
    const r = result as { success: boolean; data?: { session?: unknown } };
    expect(r.success).toBe(true);
    expect(r.data?.session).toBeDefined();
    expect(getSessionStatus).toHaveBeenCalledWith("abc");
  });

  test("end subaction calls endRemoteSession", async () => {
    const result = await remoteDesktopAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "end", sessionId: "abc" } },
    );
    const r = result as { success: boolean };
    expect(r.success).toBe(true);
    expect(endRemoteSession).toHaveBeenCalledWith("abc");
  });

  test("list subaction returns active sessions", async () => {
    const result = await remoteDesktopAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "list" } },
    );
    const r = result as {
      success: boolean;
      data?: { sessions?: unknown[] };
      values?: { count?: number };
    };
    expect(r.success).toBe(true);
    expect(listActiveSessions).toHaveBeenCalled();
    expect(r.values?.count).toBe(1);
    expect(r.data?.sessions).toHaveLength(1);
  });
});
