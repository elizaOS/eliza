/**
 * Drives the session compatibility API through real Node request/response
 * objects and the real session manager. Only the target executor is synthetic;
 * route auth, decoding, lifecycle, sequencing, and response status are real.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { ComputerUseSessionManager } from "../sessions/session-manager.js";
import type {
  ComputerUseSessionAction,
  CreateComputerUseSessionInput,
} from "../sessions/types.js";

vi.mock("@elizaos/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/core")>()),
  resolveAliasedEnvValue: () => undefined,
}));

const { handleComputerUseCompatRoutes } = await import(
  "./computer-use-compat-routes.js"
);

function sessionService() {
  let id = 0;
  const manager = new ComputerUseSessionManager({
    idFactory: () => `session-${++id}`,
    executor: async (_target, sessionAction) => ({
      success: true,
      cursorPosition:
        sessionAction.command === "mouse_move" ? { x: 20, y: 30 } : undefined,
    }),
    frameProvider: async () => ({ mimeType: "image/png", data: "cG5n" }),
  });
  return {
    listApps: async () => [
      { id: "fixture.app", name: "Fixture", pid: 42, active: true },
    ],
    getAppState: async (app: string, options?: { disableDiff?: boolean }) => ({
      stateId: `${app}:state-1`,
      app: { id: app, name: "Fixture", pid: 42, active: true },
      capturedAt: "2026-08-23T00:00:00.000Z",
      permission: "ready" as const,
      elements: [],
      axText: "fixture AX tree",
      ...(options?.disableDiff ? {} : { diff: undefined }),
    }),
    getAppControlReadiness: () => ({
      available: true,
      adapter: "fixture-ax",
      permission: "ready",
    }),
    createSession: (input: CreateComputerUseSessionInput) =>
      manager.create(input),
    listSessions: () => manager.list(),
    getSession: (sessionId: string) => manager.get(sessionId),
    closeSession: (sessionId: string) => manager.close(sessionId),
    pauseSession: (sessionId: string) => manager.pause(sessionId),
    resumeSession: (sessionId: string) => manager.resume(sessionId),
    stopSession: (sessionId: string) => manager.stop(sessionId),
    renewSessionLease: (sessionId: string, leaseTtlMs?: number) =>
      manager.renewHostLease(sessionId, leaseTtlMs),
    executeSessionAction: (
      sessionId: string,
      action: ComputerUseSessionAction,
    ) => manager.execute(sessionId, action),
    captureSessionFrame: (sessionId: string) => manager.captureFrame(sessionId),
    getSessionEvents: (afterEventId?: number) =>
      manager.getEvents(afterEventId),
    subscribeSessions: (
      listener: Parameters<ComputerUseSessionManager["subscribe"]>[0],
    ) => manager.subscribe(listener),
    getCapabilities: () => ({
      screenshot: { available: true, tool: "fixture-capture" },
      computerUse: { available: true, tool: "fixture-input" },
      windowList: { available: true, tool: "fixture-window" },
      browser: { available: true, tool: "fixture-browser" },
      terminal: { available: false, tool: "disabled" },
      fileSystem: { available: false, tool: "disabled" },
      clipboard: { available: false, tool: "disabled" },
    }),
    getApprovalSnapshot: () => ({
      mode: "smart_approve" as const,
      pendingCount: 0,
      pendingApprovals: [],
    }),
  };
}

async function request(options: {
  path: string;
  method: string;
  body?: Record<string, unknown>;
  service: ReturnType<typeof sessionService>;
  remoteAddress?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: options.remoteAddress ?? "127.0.0.1",
    configurable: true,
  });
  const req = new IncomingMessage(socket);
  Object.defineProperty(req.socket, "remoteAddress", {
    value: options.remoteAddress ?? "127.0.0.1",
    configurable: true,
  });
  req.method = options.method;
  req.url = options.path;
  Object.defineProperty(req, "headers", { value: {}, configurable: true });
  if (options.body) {
    (req as IncomingMessage & { body?: unknown }).body = options.body;
  }
  let body = "";
  const res = new ServerResponse(req);
  res.end = function end(
    this: ServerResponse,
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): ServerResponse {
    body = typeof chunk === "string" ? chunk : "";
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return this;
  };
  await handleComputerUseCompatRoutes(req, res, {
    current: { getService: () => options.service },
  });
  return {
    status: res.statusCode,
    body: body ? (JSON.parse(body) as Record<string, unknown>) : {},
  };
}

describe("computer-use session compatibility routes", () => {
  it("lists apps and returns a no-store app accessibility state", async () => {
    const service = sessionService();
    const apps = await request({
      path: "/api/computer-use/apps",
      method: "GET",
      service,
    });
    expect(apps).toMatchObject({
      status: 200,
      body: { apps: [{ id: "fixture.app", pid: 42 }] },
    });

    const state = await request({
      path: "/api/computer-use/apps/state?app=fixture.app&disableDiff=true",
      method: "GET",
      service,
    });
    expect(state).toMatchObject({
      status: 200,
      body: {
        state: {
          stateId: "fixture.app:state-1",
          permission: "ready",
          axText: "fixture AX tree",
        },
      },
    });
  });

  it("creates, lists, executes, and closes a host session", async () => {
    const service = sessionService();
    const created = await request({
      path: "/api/computer-use/sessions",
      method: "POST",
      body: { label: "primary", target: { kind: "host" } },
      service,
    });
    expect(created.status).toBe(201);
    const session = created.body.session as { id: string; sequence: number };

    const observed = await request({
      path: `/api/computer-use/sessions/${session.id}/frame`,
      method: "GET",
      service,
    });
    const provenance = (
      observed.body.frame as {
        provenance: { observationId: string; sequence: number };
      }
    ).provenance;

    const actionResult = await request({
      path: `/api/computer-use/sessions/${session.id}/actions`,
      method: "POST",
      body: {
        actionId: "action-1",
        expectedSequence: 0,
        command: "mouse_move",
        parameters: { coordinate: [20, 30] },
        observationId: provenance.observationId,
        observationSequence: provenance.sequence,
      },
      service,
    });
    expect(actionResult.status).toBe(200);
    expect(actionResult.body).toMatchObject({
      session: { sequence: 1, cursor: { x: 20, y: 30 } },
      result: { success: true },
    });

    const frame = await request({
      path: `/api/computer-use/sessions/${session.id}/frame`,
      method: "GET",
      service,
    });
    expect(frame.body).toMatchObject({
      frame: { mimeType: "image/png", data: "cG5n" },
    });
    expect(service.getSession(session.id)?.sequence).toBe(1);

    const listed = await request({
      path: "/api/computer-use/sessions",
      method: "GET",
      service,
    });
    expect(listed.body.sessions).toEqual([
      expect.objectContaining({ id: session.id, sequence: 1 }),
    ]);
    expect(listed.body).toMatchObject({
      readiness: {
        capture: { available: true, tool: "fixture-capture" },
        input: { available: true, tool: "fixture-input" },
        approvalMode: "smart_approve",
      },
      events: expect.any(Array),
    });

    const closed = await request({
      path: `/api/computer-use/sessions/${session.id}`,
      method: "DELETE",
      service,
    });
    expect(closed.body).toMatchObject({ session: { status: "closed" } });
  });

  it("returns typed conflicts for host lease and stale actions", async () => {
    const service = sessionService();
    const first = await request({
      path: "/api/computer-use/sessions",
      method: "POST",
      body: { target: { kind: "host" } },
      service,
    });
    const conflict = await request({
      path: "/api/computer-use/sessions",
      method: "POST",
      body: { target: { kind: "host" } },
      service,
    });
    expect(conflict).toMatchObject({
      status: 409,
      body: { code: "HOST_LEASE_CONFLICT" },
    });

    const sessionId = (first.body.session as { id: string }).id;
    const stale = await request({
      path: `/api/computer-use/sessions/${sessionId}/actions`,
      method: "POST",
      body: {
        actionId: "action-stale",
        expectedSequence: 7,
        command: "mouse_move",
      },
      service,
    });
    expect(stale).toMatchObject({
      status: 409,
      body: { code: "STALE_SESSION_SEQUENCE" },
    });
  });

  it("fails closed when the socket peer is not local and no token is configured", async () => {
    const response = await request({
      path: "/api/computer-use/sessions",
      method: "GET",
      service: sessionService(),
      remoteAddress: "8.8.8.8",
    });
    expect(response).toEqual({ status: 401, body: { error: "Unauthorized" } });
  });

  it("rejects malformed session path encoding before service access", async () => {
    const service = sessionService();
    const response = await request({
      path: "/api/computer-use/sessions/%ZZ",
      method: "GET",
      service,
    });
    expect(response).toEqual({
      status: 400,
      body: { error: "Invalid session id: malformed URL encoding" },
    });
  });

  it("rejects malformed optional create fields instead of dropping them", async () => {
    const service = sessionService();
    const invalidLabel = await request({
      path: "/api/computer-use/sessions",
      method: "POST",
      body: { label: 7, target: { kind: "host" } },
      service,
    });
    expect(invalidLabel.status).toBe(400);

    const invalidViewer = await request({
      path: "/api/computer-use/sessions",
      method: "POST",
      body: {
        target: { kind: "browser", targetId: "browser-one", viewerUrl: 7 },
      },
      service,
    });
    expect(invalidViewer.status).toBe(400);
    expect(service.listSessions()).toHaveLength(0);
  });
});
