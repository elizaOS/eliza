/**
 * Regression test for shell-session registration in the spawn route.
 *
 * Bug: `POST /api/coding-agents/spawn` with `{ agentType: "shell" }` (no task)
 * spawned the PTY but never registered the session with the coordinator, which
 * is the only source of the `task_registered` WS broadcast and the
 * `/coordinator/status` hydration endpoint. The UI's `ptySessions` stayed
 * empty, so the Terminal channel was stuck on "Starting terminal…" forever
 * (see eliza/packages/app-core/src/components/pages/ChatView.tsx → TerminalChannelPanel).
 *
 * Fix: drop the `&& task` gate at spawn time — register every coordinator-
 * available session, defaulting originalTask to "" for shells.
 */

import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentRoutes } from "../api/agent-routes.js";

function makeRequest(body: unknown) {
  const stream = Readable.from([JSON.stringify(body)]) as Readable & {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
  };
  stream.method = "POST";
  stream.url = "/api/coding-agents/spawn";
  stream.headers = { "content-type": "application/json" };
  return stream;
}

function makeResponse() {
  let statusCode = 200;
  let body = "";
  const res = {
    writeHead: (code: number) => {
      statusCode = code;
    },
    end: (chunk?: string) => {
      if (chunk) body += chunk;
    },
    getStatus: () => statusCode,
    getBody: () => body,
    getJson: <T = unknown>() => JSON.parse(body) as T,
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal mock
  return res as any;
}

describe("handleAgentRoutes POST /spawn — shell session registers with coordinator", () => {
  const registerTask = vi.fn();
  const coordinator = {
    registerTask,
    createTaskThread: vi.fn(),
    getTaskThread: vi.fn(),
  };
  const ptyService = {
    coordinator,
    listSessions: vi.fn(async () => []),
    resolveAgentType: vi.fn(async () => "claude"),
    spawnSession: vi.fn(
      async (opts: { agentType: string; workdir: string }) => ({
        id: "pty-test-0001",
        agentType: opts.agentType,
        workdir: opts.workdir,
        status: "starting",
      }),
    ),
  };
  const runtime = {
    getSetting: vi.fn((key: string) => {
      // buildAgentCredentials reads subscription/provider keys — return a
      // dummy API key so it synthesizes without throwing.
      if (key === "ANTHROPIC_API_KEY") return "test-anthropic-key";
      return null;
    }),
    getService: vi.fn((type: string) =>
      type === "PTY_SERVICE" ? ptyService : null,
    ),
  };

  beforeEach(() => {
    registerTask.mockReset();
    ptyService.listSessions.mockClear();
    ptyService.spawnSession.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers shell sessions with the coordinator even when no task is provided", async () => {
    const req = makeRequest({ agentType: "shell", workdir: process.cwd() });
    const res = makeResponse();

    const handled = await handleAgentRoutes(
      req as unknown as import("http").IncomingMessage,
      res,
      "/api/coding-agents/spawn",
      {
        // biome-ignore lint/suspicious/noExplicitAny: minimal mock
        runtime: runtime as any,
        // biome-ignore lint/suspicious/noExplicitAny: minimal mock
        ptyService: ptyService as any,
        workspaceService: null,
        // biome-ignore lint/suspicious/noExplicitAny: minimal mock
        coordinator: coordinator as any,
      },
    );

    expect(handled).toBe(true);
    if (res.getStatus() !== 201) {
      // Surface the server-side error to the test output so the failure
      // message is actionable rather than a bare 500.
      throw new Error(
        `spawn route returned ${res.getStatus()}: ${res.getBody()}`,
      );
    }
    expect(res.getJson<{ sessionId: string }>().sessionId).toBe(
      "pty-test-0001",
    );

    // The bug was that this assertion failed — registerTask was never called
    // because the route had `if (coordinator && task)`.
    expect(registerTask).toHaveBeenCalledTimes(1);
    const [sessionId, context] = registerTask.mock.calls[0];
    expect(sessionId).toBe("pty-test-0001");
    expect(context.agentType).toBe("shell");
    expect(context.originalTask).toBe("");
    expect(context.label).toMatch(/^shell-/);
  });
});
