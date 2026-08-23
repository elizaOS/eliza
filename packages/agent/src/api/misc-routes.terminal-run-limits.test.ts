/**
 * Exercises terminal execution limits at the real route orchestration boundary
 * while mocking only the shell process. The harness covers concurrent admission,
 * lease release, and the combined UTF-8 output budget without executing commands.
 */

import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ShellRequest,
  ShellResult,
} from "../services/shell-execution-router.ts";
import { handleMiscRoutes, type MiscRouteContext } from "./misc-routes.ts";
import { AGENT_EVENT_ALLOWED_STREAMS } from "./plugin-discovery-helpers.ts";

const runShellMock = vi.hoisted(() => vi.fn());

vi.mock("../services/shell-execution-router.ts", () => ({
  runShell: runShellMock,
}));
vi.mock("../runtime/custom-actions.ts", () => ({
  buildTestHandler: vi.fn(),
  registerCustomActionLive: vi.fn(),
}));
vi.mock("../config/config.ts", () => ({
  loadElizaConfig: vi.fn(() => ({})),
  saveElizaConfig: vi.fn(),
}));
vi.mock("./server-helpers.ts", () => ({
  decodePathComponent: vi.fn((value: string) => value),
}));

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function shellResult(overrides: Partial<ShellResult> = {}): ShellResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    sandbox: "host",
    ...overrides,
  };
}

function createLeaseGate(): {
  active: () => number;
  acquire: MiscRouteContext["tryAcquireTerminalRunSlot"];
} {
  let active = 0;
  const seen = new Set<string>();
  return {
    active: () => active,
    acquire: (scopeId, runId, maxConcurrent) => {
      const reservationKey = `${scopeId}:${runId}`;
      if (seen.has(reservationKey)) return { rejection: "duplicate" };
      if (active >= maxConcurrent) return { rejection: "capacity" };
      seen.add(reservationKey);
      active += 1;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          active -= 1;
        },
      };
    },
  };
}

function makeContext(
  runId: string,
  gate: ReturnType<typeof createLeaseGate>,
): {
  ctx: MiscRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const req = {
    headers: { "x-eliza-terminal-run-id": runId },
  } as unknown as http.IncomingMessage;
  const res = {
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();
  const ctx: MiscRouteContext = {
    req,
    res,
    method: "POST",
    pathname: "/api/terminal/run",
    url: new URL("http://localhost/api/terminal/run"),
    state: {
      config: {} as MiscRouteContext["state"]["config"],
      runtime: {
        agentId: "00000000-0000-0000-0000-0000000000aa",
      } as AgentRuntime,
      agentState: "running",
      agentName: "Eliza",
      shellEnabled: true,
      broadcastWs: vi.fn(),
      broadcastWsToClientId: vi.fn(),
      nextEventId: 1,
      eventBuffer: [],
      shareIngestQueue: [],
      startup: { phase: "running", attempt: 0 },
      broadcastStatus: vi.fn(),
      pendingRestartReasons: [],
    },
    json,
    error,
    readJsonBody: vi.fn().mockResolvedValue({
      command: "printf test",
      clientId: "terminal-test",
      captureOutput: true,
    }),
    AGENT_EVENT_ALLOWED_STREAMS,
    resolveTerminalRunRejection: vi.fn().mockReturnValue(null),
    resolveTerminalRunClientId: vi.fn().mockReturnValue("terminal-test"),
    isSharedTerminalClientId: vi.fn().mockReturnValue(false),
    activeTerminalRunCount: 0,
    setActiveTerminalRunCount: vi.fn(),
    tryAcquireTerminalRunSlot: gate.acquire,
  };
  return { ctx, json, error };
}

function broadcastCalls(ctx: MiscRouteContext) {
  const broadcast = ctx.state.broadcastWsToClientId;
  if (!broadcast) throw new Error("test route requires a targeted broadcaster");
  return vi.mocked(broadcast).mock.calls;
}

afterEach(() => {
  vi.unstubAllEnvs();
  runShellMock.mockReset();
});

describe("terminal run limits", () => {
  it("atomically rejects a concurrent request and releases the slot exactly once", async () => {
    vi.stubEnv("ELIZA_TERMINAL_MAX_CONCURRENT", "1");
    const gate = createLeaseGate();
    const firstRun = deferred<ShellResult>();
    runShellMock.mockReturnValueOnce(firstRun.promise);
    const first = makeContext("run-00000000-0000-4000-8000-000000000001", gate);
    const second = makeContext(
      "run-00000000-0000-4000-8000-000000000002",
      gate,
    );

    expect(await handleMiscRoutes(first.ctx)).toBe(true);
    expect(await handleMiscRoutes(second.ctx)).toBe(true);
    expect(runShellMock).toHaveBeenCalledTimes(1);
    expect(second.error).toHaveBeenCalledWith(
      second.ctx.res,
      "Too many active terminal runs (1). Wait for a command to finish.",
      429,
    );
    expect(gate.active()).toBe(1);

    firstRun.resolve(shellResult());
    await vi.waitFor(() => expect(first.json).toHaveBeenCalledOnce());
    expect(gate.active()).toBe(0);

    const third = makeContext("run-00000000-0000-4000-8000-000000000003", gate);
    runShellMock.mockResolvedValueOnce(shellResult());
    expect(await handleMiscRoutes(third.ctx)).toBe(true);
    await vi.waitFor(() => expect(third.json).toHaveBeenCalledOnce());
    expect(gate.active()).toBe(0);
  });

  it("rejects an oversized capture instead of returning a partial prefix", async () => {
    const gate = createLeaseGate();
    runShellMock.mockImplementationOnce(async (request: ShellRequest) => {
      request.onStdout?.("a".repeat(4 * 1024 * 1024));
      request.onStderr?.("你");
      return shellResult();
    });
    const route = makeContext("run-00000000-0000-4000-8000-000000000004", gate);

    expect(await handleMiscRoutes(route.ctx)).toBe(true);
    await vi.waitFor(() => expect(route.error).toHaveBeenCalledOnce());
    expect(route.json).not.toHaveBeenCalled();
    expect(route.error).toHaveBeenCalledWith(
      route.ctx.res,
      expect.stringContaining("no partial result was returned"),
      413,
    );
    const events = broadcastCalls(route.ctx);
    expect(
      events.some((call) =>
        ["stdout", "stderr"].includes(
          String((call[1] as { event?: unknown } | undefined)?.event),
        ),
      ),
    ).toBe(false);
    expect(gate.active()).toBe(0);
  });

  it("does not broadcast buffered partial output from a timed-out capture", async () => {
    const gate = createLeaseGate();
    runShellMock.mockImplementationOnce(async (request: ShellRequest) => {
      request.onStdout?.("partial secret");
      return shellResult({ exitCode: 124 });
    });
    const route = makeContext("run-00000000-0000-4000-8000-000000000014", gate);

    expect(await handleMiscRoutes(route.ctx)).toBe(true);
    await vi.waitFor(() => expect(route.error).toHaveBeenCalledOnce());
    const events = broadcastCalls(route.ctx);
    expect(
      events.some((call) =>
        ["stdout", "stderr"].includes(
          String((call[1] as { event?: unknown } | undefined)?.event),
        ),
      ),
    ).toBe(false);
    expect(route.json).not.toHaveBeenCalled();
    expect(route.error).toHaveBeenCalledWith(
      route.ctx.res,
      "Terminal execution timed out; no partial result was returned.",
      504,
    );
  });

  it.each(["unsafe\u0000output", "invalid\ufffdutf8", "bidi\u202eoverride"])(
    "rejects unsafe captured text without publishing it: %j",
    async (unsafeOutput) => {
      const gate = createLeaseGate();
      runShellMock.mockImplementationOnce(async (request: ShellRequest) => {
        request.onStdout?.(unsafeOutput);
        return shellResult({ stdout: unsafeOutput });
      });
      const route = makeContext(
        `run-00000000-0000-4000-8000-0000000000${15 + unsafeOutput.length}`,
        gate,
      );

      expect(await handleMiscRoutes(route.ctx)).toBe(true);
      await vi.waitFor(() => expect(route.error).toHaveBeenCalledOnce());
      expect(route.json).not.toHaveBeenCalled();
      expect(route.error).toHaveBeenCalledWith(
        route.ctx.res,
        "Terminal output was not valid safe text; no result was returned.",
        422,
      );
      expect(JSON.stringify(broadcastCalls(route.ctx))).not.toContain(
        unsafeOutput,
      );
    },
  );

  it("releases admission when the shell launcher throws synchronously", async () => {
    const gate = createLeaseGate();
    runShellMock.mockImplementationOnce(() => {
      throw new Error("launch failed");
    });
    const route = makeContext("run-00000000-0000-4000-8000-000000000005", gate);

    expect(await handleMiscRoutes(route.ctx)).toBe(true);
    await vi.waitFor(() => expect(route.error).toHaveBeenCalledOnce());
    expect(route.error).toHaveBeenCalledWith(
      route.ctx.res,
      "Terminal execution failed",
      500,
    );
    expect(JSON.stringify(broadcastCalls(route.ctx))).not.toContain(
      "launch failed",
    );
    expect(gate.active()).toBe(0);
  });

  it("releases admission when shell resolution fails before launch", async () => {
    const gate = createLeaseGate();
    const route = makeContext("run-00000000-0000-4000-8000-000000000010", gate);
    route.ctx.resolveTerminalShellCommand = () => {
      throw new Error("shell resolution failed");
    };

    expect(await handleMiscRoutes(route.ctx)).toBe(true);
    await vi.waitFor(() => expect(route.error).toHaveBeenCalledOnce());
    expect(runShellMock).not.toHaveBeenCalled();
    expect(gate.active()).toBe(0);
  });

  it("rejects reuse of a run id before and after the first run settles", async () => {
    const gate = createLeaseGate();
    const pending = deferred<ShellResult>();
    const runId = "run-00000000-0000-4000-8000-000000000006";
    runShellMock.mockReturnValueOnce(pending.promise);
    const first = makeContext(runId, gate);
    const concurrentReplay = makeContext(runId, gate);

    expect(await handleMiscRoutes(first.ctx)).toBe(true);
    expect(await handleMiscRoutes(concurrentReplay.ctx)).toBe(true);
    expect(concurrentReplay.error).toHaveBeenCalledWith(
      concurrentReplay.ctx.res,
      "Terminal run id was already used",
      409,
    );

    pending.resolve(shellResult());
    await vi.waitFor(() => expect(first.json).toHaveBeenCalledOnce());
    const settledReplay = makeContext(runId, gate);
    expect(await handleMiscRoutes(settledReplay.ctx)).toBe(true);
    expect(settledReplay.error).toHaveBeenCalledWith(
      settledReplay.ctx.res,
      "Terminal run id was already used",
      409,
    );
    expect(runShellMock).toHaveBeenCalledOnce();
  });

  it("binds replay reservations to the agent rather than caller-controlled client ids", async () => {
    const gate = createLeaseGate();
    const runId = "run-00000000-0000-4000-8000-000000000008";
    runShellMock.mockResolvedValue(shellResult());
    const first = makeContext(runId, gate);
    const otherClient = makeContext(runId, gate);
    vi.mocked(otherClient.ctx.resolveTerminalRunClientId).mockReturnValue(
      "terminal-other",
    );

    expect(await handleMiscRoutes(first.ctx)).toBe(true);
    await vi.waitFor(() => expect(first.json).toHaveBeenCalledOnce());
    expect(await handleMiscRoutes(otherClient.ctx)).toBe(true);
    expect(otherClient.error).toHaveBeenCalledWith(
      otherClient.ctx.res,
      "Terminal run id was already used",
      409,
    );

    const otherAgent = makeContext(runId, gate);
    otherAgent.ctx.state.runtime = {
      agentId: "00000000-0000-4000-8000-0000000000bb",
    } as AgentRuntime;
    expect(await handleMiscRoutes(otherAgent.ctx)).toBe(true);
    await vi.waitFor(() => expect(otherAgent.json).toHaveBeenCalledOnce());
    expect(runShellMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a subscriber failure from masking the result or leaking admission", async () => {
    const gate = createLeaseGate();
    runShellMock.mockResolvedValueOnce(shellResult());
    const route = makeContext("run-00000000-0000-4000-8000-000000000009", gate);
    route.ctx.state.broadcastWsToClientId = vi.fn(() => {
      throw new Error("subscriber closed");
    });

    expect(await handleMiscRoutes(route.ctx)).toBe(true);
    await vi.waitFor(() => expect(route.json).toHaveBeenCalledOnce());
    expect(gate.active()).toBe(0);
  });

  it("fails closed when the run-id reservation registry is saturated", async () => {
    const gate = createLeaseGate();
    const route = makeContext("run-00000000-0000-4000-8000-000000000007", gate);
    route.ctx.tryAcquireTerminalRunSlot = () => ({
      rejection: "registry-capacity",
    });

    expect(await handleMiscRoutes(route.ctx)).toBe(true);
    expect(route.error).toHaveBeenCalledWith(
      route.ctx.res,
      "Terminal run admission is temporarily unavailable",
      503,
    );
    expect(runShellMock).not.toHaveBeenCalled();
  });
});
