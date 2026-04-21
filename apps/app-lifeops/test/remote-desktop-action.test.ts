/**
 * REMOTE-DESKTOP ACTION TESTS — mixed scope.
 *
 * Part 1 (LARP caveat — mocks the entire target module):
 *   The top-level `describe("remoteDesktopAction")` block replaces the whole
 *   `../src/lifeops/remote-desktop.js` module with `vi.fn()` stubs for every
 *   public function (`startRemoteSession`, `getSessionStatus`,
 *   `endRemoteSession`, `listActiveSessions`, `detectRemoteDesktopBackend`).
 *   Assertions like `expect(startRemoteSession).toHaveBeenCalledTimes(1)` and
 *   `expect(r.data?.session).toBeDefined()` only verify the action handler
 *   wires the correct subaction to the correct mocked function. They do NOT
 *   verify:
 *     - That the real session store (the module-level `sessions` Map) receives
 *       and returns real sessions.
 *     - That `endRemoteSession` actually removes a live session.
 *     - That the "status !== active" failure branch formats its ActionResult
 *       correctly.
 *     - That `formatSession` produces the right multi-line text the owner
 *       sees in chat.
 *   If the action were refactored to never call `startRemoteSession` at all
 *   (e.g. a broken early-return), Part 1 would catch that — but if the action
 *   called `startRemoteSession` and then threw away the result, Part 1 would
 *   still go green on the weak `r.data?.session !== undefined` check.
 *
 * Part 2 (see `describe("remoteDesktopAction (real module in mock mode)")`):
 *   Unmocks the module, re-imports it with `MILADY_TEST_REMOTE_DESKTOP_BACKEND=1`,
 *   and exercises the full lifecycle (start → status → list → end) through the
 *   action handler against the real in-process session store. This catches
 *   mis-wiring between the handler and the session store that Part 1 cannot.
 */
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

/**
 * Real-integration suite: unmocks `remote-desktop.js`, enables the
 * module's built-in `MILADY_TEST_REMOTE_DESKTOP_BACKEND=1` mock-backend, and
 * drives the action handler end-to-end against the module's real in-process
 * session store.
 *
 * This catches handler / session-store wiring regressions that the mocked
 * suite above cannot (e.g. the handler ignoring `session.status === "active"`
 * when deciding success, or `endRemoteSession` never actually mutating the
 * store).
 */
describe("remoteDesktopAction (real module in mock mode)", () => {
  const PREV_MOCK_ENV = process.env.MILADY_TEST_REMOTE_DESKTOP_BACKEND;

  beforeEach(() => {
    process.env.MILADY_TEST_REMOTE_DESKTOP_BACKEND = "1";
    vi.doUnmock("../src/lifeops/remote-desktop.js");
    vi.resetModules();
  });

  afterEach(() => {
    if (PREV_MOCK_ENV === undefined) {
      delete process.env.MILADY_TEST_REMOTE_DESKTOP_BACKEND;
    } else {
      process.env.MILADY_TEST_REMOTE_DESKTOP_BACKEND = PREV_MOCK_ENV;
    }
    // Re-mock so the following test file runs (not strictly necessary here
    // but keeps isolation clean if anyone adds more describes below).
    vi.doMock("../src/lifeops/remote-desktop.js", () => ({
      startRemoteSession: vi.fn(),
      getSessionStatus: vi.fn(),
      endRemoteSession: vi.fn(),
      listActiveSessions: vi.fn(async () => []),
      detectRemoteDesktopBackend: vi.fn(async () => "tailscale-vnc" as const),
    }));
  });

  test("start(confirmed=true) → status → end writes a real session to the in-process store", async () => {
    // Dynamic import AFTER vi.doUnmock + vi.resetModules so we get the real
    // modules this time.
    const { remoteDesktopAction: realAction } = await import(
      "../src/actions/remote-desktop.js"
    );

    // Start a session.
    const startResult = await realAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "start", confirmed: true } },
    );
    const started = startResult as {
      success: boolean;
      values?: {
        sessionId?: string;
        backend?: string;
        accessUrl?: string | null;
        accessCode?: string | null;
        expiresAt?: string | null;
      };
      data?: { session?: { status?: string; mockMode?: boolean } };
    };

    expect(started.success).toBe(true);
    expect(typeof started.values?.sessionId).toBe("string");
    expect(started.values?.sessionId?.length ?? 0).toBeGreaterThan(0);
    // The REAL mock-backend path in remote-desktop.ts sets mockMode: true and
    // status: "active", and generates a vnc://127.0.0.1 URL. The old mocked
    // suite above could NEVER verify these because it stubs the entire module.
    expect(started.data?.session?.status).toBe("active");
    expect(started.data?.session?.mockMode).toBe(true);
    expect(started.values?.accessUrl).toMatch(/^vnc:\/\/127\.0\.0\.1:/);
    expect(typeof started.values?.accessCode).toBe("string");
    expect(typeof started.values?.expiresAt).toBe("string");

    const sessionId = started.values!.sessionId!;

    // Status should find the session we just created (real store lookup).
    const statusResult = await realAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "status", sessionId } },
    );
    const status = statusResult as {
      success: boolean;
      values?: { status?: string };
      data?: { session?: { id?: string; status?: string } };
    };
    expect(status.success).toBe(true);
    expect(status.values?.status).toBe("active");
    expect(status.data?.session?.id).toBe(sessionId);

    // List should include the active session.
    const listResult = await realAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "list" } },
    );
    const list = listResult as {
      success: boolean;
      values?: { count?: number };
      data?: { sessions?: Array<{ id: string }> };
    };
    expect(list.success).toBe(true);
    expect(list.values?.count ?? 0).toBeGreaterThanOrEqual(1);
    expect(list.data?.sessions?.some((s) => s.id === sessionId)).toBe(true);

    // End → the real store should transition the session to "ended".
    const endResult = await realAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "end", sessionId } },
    );
    const ended = endResult as { success: boolean; values?: { sessionId?: string } };
    expect(ended.success).toBe(true);
    expect(ended.values?.sessionId).toBe(sessionId);

    // After end, status should reflect "ended" (store actually mutated).
    const postEnd = await realAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "status", sessionId } },
    );
    const postEndTyped = postEnd as {
      success: boolean;
      values?: { status?: string };
    };
    expect(postEndTyped.values?.status).toBe("ended");
  });
});
