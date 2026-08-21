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
  acquire: (maxConcurrent: number) => (() => void) | null;
} {
  let active = 0;
  return {
    active: () => active,
    acquire: (maxConcurrent) => {
      if (active >= maxConcurrent) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
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

  it("shares one 128 KiB budget across stdout and stderr without broken UTF-8", async () => {
    const gate = createLeaseGate();
    runShellMock.mockImplementationOnce(async (request: ShellRequest) => {
      request.onStdout?.("a".repeat(128 * 1024 - 2));
      request.onStderr?.("你");
      return shellResult();
    });
    const route = makeContext("run-00000000-0000-4000-8000-000000000004", gate);

    expect(await handleMiscRoutes(route.ctx)).toBe(true);
    await vi.waitFor(() => expect(route.json).toHaveBeenCalledOnce());
    const payload = route.json.mock.calls[0]?.[1] as {
      stdout: string;
      stderr: string;
      truncated: boolean;
    };
    expect(
      Buffer.byteLength(payload.stdout) + Buffer.byteLength(payload.stderr),
    ).toBeLessThanOrEqual(128 * 1024);
    expect(payload.stdout).toHaveLength(128 * 1024 - 2);
    expect(payload.stderr).toBe("");
    expect(payload.truncated).toBe(true);
    expect(`${payload.stdout}${payload.stderr}`).not.toContain("\uFFFD");
    expect(gate.active()).toBe(0);
  });
});
