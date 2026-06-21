/**
 * Route-level e2e for plugin-computeruse (issue #8802).
 *
 * Boots the plugin's declared `Route[]` (`computerUseRoutes`) through the real
 * production dispatcher (`tryHandleRuntimePluginRoute`) over a loopback
 * `http.createServer` — exercising the real auth gate, JSON body parsing, query
 * parsing, and handler dispatch — with a faked `ComputerUseService` standing in
 * for the only external dependency. No mocked `json`/`error` functions: every
 * assertion is on a real HTTP response over `fetch`.
 *
 * The plugin's compat handler (`computer-use-compat-routes.ts`) trusts loopback
 * requests internally (`isTrustedLocalRequest`), so the handler always runs once
 * the dispatcher lets the request through. The dispatcher-level auth gate
 * (`route.public !== true && !isAuthorized()`) runs *before* the handler, so it
 * is fully exercisable here without any real desktop control.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { computerUsePlugin } from "../index.ts";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
});

type ApprovalMode = "full_control" | "smart_approve" | "approve_all" | "off";

interface ApprovalSnapshot {
  mode: ApprovalMode;
  pendingCount: number;
  pendingApprovals: Array<{
    id: string;
    command: string;
    parameters: Record<string, unknown>;
    requestedAt: string;
  }>;
}

interface ApprovalResolution {
  id: string;
  command: string;
  approved: boolean;
  cancelled: boolean;
  mode: ApprovalMode;
  requestedAt: string;
  resolvedAt: string;
  reason?: string;
}

interface FakeServiceState {
  mode: ApprovalMode;
  calls: string[];
  resolveResult: ApprovalResolution | null;
}

const SNAPSHOT: ApprovalSnapshot = {
  mode: "smart_approve",
  pendingCount: 1,
  pendingApprovals: [
    {
      id: "approval-1",
      command: "COMPUTER_USE_CLICK",
      parameters: { x: 10, y: 20 },
      requestedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

function fakeService(state: FakeServiceState) {
  return {
    getApprovalSnapshot(): ApprovalSnapshot {
      state.calls.push("getApprovalSnapshot");
      return { ...SNAPSHOT, mode: state.mode };
    },
    setApprovalMode(mode: ApprovalMode): ApprovalMode {
      state.calls.push(`setApprovalMode:${mode}`);
      state.mode = mode;
      return mode;
    },
    resolveApproval(
      id: string,
      approved: boolean,
      reason?: string,
    ): ApprovalResolution | null {
      state.calls.push(`resolveApproval:${id}:${approved}:${reason ?? ""}`);
      return state.resolveResult;
    },
    subscribeApprovals(
      _listener: (snapshot: ApprovalSnapshot) => void,
    ): () => void {
      return () => {};
    },
  };
}

function makeRuntime(
  options: { withService?: boolean; state?: FakeServiceState } = {},
): AgentRuntime {
  const { withService = true, state } = options;
  const service = state ? fakeService(state) : null;
  return {
    routes: computerUsePlugin.routes,
    getService: (key: string) =>
      withService && key === "computeruse" ? service : null,
  } as unknown as AgentRuntime;
}

async function startServer(
  runtime: AgentRuntime,
  isAuthorized: () => boolean = () => true,
): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      runtime,
      isAuthorized,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postJson(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function freshState(
  overrides: Partial<FakeServiceState> = {},
): FakeServiceState {
  return {
    mode: "smart_approve",
    calls: [],
    resolveResult: null,
    ...overrides,
  };
}

describe("plugin-computeruse routes (real dispatch)", () => {
  it("returns the approval snapshot on GET /approvals when authorized", async () => {
    const state = freshState();
    const base = await startServer(makeRuntime({ state }));
    const res = await fetch(`${base}/api/computer-use/approvals`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApprovalSnapshot;
    expect(body.mode).toBe("smart_approve");
    expect(body.pendingCount).toBe(1);
    expect(body.pendingApprovals[0]?.id).toBe("approval-1");
    expect(state.calls).toContain("getApprovalSnapshot");
  });

  it("enforces the dispatcher auth gate on the non-public GET /approvals route", async () => {
    const state = freshState();
    const base = await startServer(makeRuntime({ state }), () => false);
    const res = await fetch(`${base}/api/computer-use/approvals`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Unauthorized",
    );
    // Handler never ran: the gate short-circuits before service access.
    expect(state.calls).toHaveLength(0);
  });

  it("serves the public approvals/stream route even when auth is denied", async () => {
    // Auth denied, but the stream route declares `public: true`. With no
    // service the handler writes a single snapshot frame and closes the stream
    // (a live service would keep the SSE connection open via heartbeat), so the
    // response body resolves deterministically here.
    const base = await startServer(
      makeRuntime({ withService: false }),
      () => false,
    );
    const res = await fetch(`${base}/api/computer-use/approvals/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"type":"snapshot"');
    // EMPTY_APPROVAL_SNAPSHOT is served when no service is registered.
    expect(text).toContain('"mode":"full_control"');
  });

  it("changes the approval mode on POST /approval-mode with valid input", async () => {
    const state = freshState();
    const base = await startServer(makeRuntime({ state }));
    const res = await postJson(base, "/api/computer-use/approval-mode", {
      mode: "approve_all",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mode: ApprovalMode }).mode).toBe(
      "approve_all",
    );
    expect(state.calls).toContain("setApprovalMode:approve_all");
  });

  it("rejects an invalid approval mode with 400 from the real handler", async () => {
    const state = freshState();
    const base = await startServer(makeRuntime({ state }));
    const res = await postJson(base, "/api/computer-use/approval-mode", {
      mode: "not-a-mode",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "full_control",
    );
    expect(state.calls).toHaveLength(0);
  });

  it("returns 404 from POST /approval-mode when the service is unavailable", async () => {
    const base = await startServer(makeRuntime({ withService: false }));
    const res = await postJson(base, "/api/computer-use/approval-mode", {
      mode: "off",
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain(
      "service not available",
    );
  });

  it("enforces the dispatcher auth gate on POST /approval-mode", async () => {
    const state = freshState();
    const base = await startServer(makeRuntime({ state }), () => false);
    const res = await postJson(base, "/api/computer-use/approval-mode", {
      mode: "off",
    });
    expect(res.status).toBe(401);
    expect(state.calls).toHaveLength(0);
  });

  it("resolves an approval on POST /approvals/:id and decodes the id", async () => {
    const resolution: ApprovalResolution = {
      id: "approval 1",
      command: "COMPUTER_USE_CLICK",
      approved: true,
      cancelled: false,
      mode: "smart_approve",
      requestedAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: "2026-01-01T00:00:01.000Z",
      reason: "looks fine",
    };
    const state = freshState({ resolveResult: resolution });
    const base = await startServer(makeRuntime({ state }));
    // %20 in the id segment must be URL-decoded by the handler.
    const res = await postJson(
      base,
      "/api/computer-use/approvals/approval%201",
      {
        approved: true,
        reason: "looks fine",
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApprovalResolution;
    expect(body.approved).toBe(true);
    expect(body.id).toBe("approval 1");
    expect(state.calls).toContain("resolveApproval:approval 1:true:looks fine");
  });

  it("returns 400 from POST /approvals/:id when `approved` is missing", async () => {
    const state = freshState();
    const base = await startServer(makeRuntime({ state }));
    const res = await postJson(base, "/api/computer-use/approvals/approval-1", {
      reason: "no decision",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "approved must be a boolean",
    );
    expect(state.calls).toHaveLength(0);
  });

  it("returns 404 from POST /approvals/:id for an unknown approval id", async () => {
    const state = freshState({ resolveResult: null });
    const base = await startServer(makeRuntime({ state }));
    const res = await postJson(base, "/api/computer-use/approvals/missing", {
      approved: false,
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain(
      "Approval not found",
    );
    expect(state.calls).toContain("resolveApproval:missing:false:");
  });

  it("enforces the dispatcher auth gate on POST /approvals/:id", async () => {
    const state = freshState();
    const base = await startServer(makeRuntime({ state }), () => false);
    const res = await postJson(base, "/api/computer-use/approvals/approval-1", {
      approved: true,
    });
    expect(res.status).toBe(401);
    expect(state.calls).toHaveLength(0);
  });
});
