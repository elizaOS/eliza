/**
 * HTTP handler tests for /api/workspace/* routes with a deterministic workspace service stub.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteContext } from "../../src/api/route-utils.js";
import { handleWorkspaceRoutes } from "../../src/api/workspace-routes.js";

const provisionWorkspace = vi.fn(async (opts: Record<string, unknown>) => ({
  id: "ws-1",
  path: "/tmp/ws-1",
  branch: opts.branchName ?? "main",
  isWorktree: opts.useWorktree ?? false,
}));
const getStatus = vi.fn(async (id: string) => ({
  id,
  branch: "main",
  clean: true,
}));
const commit = vi.fn(
  async (_id: string, opts: { message: string; all: boolean }) => ({
    hash: "abc1234",
    message: opts.message,
  }),
);
const push = vi.fn(async (_id: string, _opts?: Record<string, unknown>) => ({
  success: true,
}));
const createPR = vi.fn(
  async (_id: string, opts: { title: string; body: string }) => ({
    url: "https://github.com/owner/repo/pull/1",
    title: opts.title,
  }),
);
const removeWorkspace = vi.fn(async (_id: string) => undefined);

function createRouteContext(
  workspaceService: unknown = {
    provisionWorkspace,
    getStatus,
    commit,
    push,
    createPR,
    removeWorkspace,
  },
): RouteContext {
  return {
    runtime: {},
    acpService: null,
    workspaceService,
  } as never;
}

function createRequest(
  method: string,
  url: string,
  body?: unknown,
): IncomingMessage {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const stream = Readable.from(payload !== undefined ? [payload] : []);
  return Object.assign(stream, {
    method,
    url,
    headers: { host: "localhost", "content-type": "application/json" },
  }) as unknown as IncomingMessage;
}

class CapturingResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  end(chunk?: string): this {
    if (chunk !== undefined) {
      this.body = chunk;
    }
    return this;
  }

  json(): Record<string, unknown> {
    return this.body ? (JSON.parse(this.body) as Record<string, unknown>) : {};
  }
}

async function callRoute(
  method: string,
  pathname: string,
  body?: unknown,
  ctx = createRouteContext(),
) {
  const req = createRequest(method, pathname, body);
  const res = new CapturingResponse();
  const handled = await handleWorkspaceRoutes(
    req,
    res as unknown as ServerResponse,
    pathname,
    ctx,
  );
  return {
    handled,
    status: res.statusCode,
    body: res.json(),
  };
}

describe("handleWorkspaceRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/workspace/:id/commit", () => {
    it("commits changes when a valid non-empty message is provided", async () => {
      const response = await callRoute("POST", "/api/workspace/ws-123/commit", {
        message: "fix: update component styling",
      });

      expect(response.handled).toBe(true);
      expect(response.status).toBe(200);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledWith("ws-123", {
        message: "fix: update component styling",
        all: true,
      });
      expect(response.body).toEqual({
        hash: "abc1234",
        message: "fix: update component styling",
      });
    });

    it.each([
      ["missing", {}],
      ["empty string", { message: "" }],
      ["whitespace string", { message: "   " }],
      ["null", { message: null }],
      ["number", { message: 12345 }],
      ["boolean", { message: true }],
      ["object", { message: { text: "msg" } }],
    ])("rejects %s message with 400", async (_desc, body) => {
      const response = await callRoute(
        "POST",
        "/api/workspace/ws-123/commit",
        body,
      );

      expect(response.handled).toBe(true);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: "message is required",
      });
      expect(commit).not.toHaveBeenCalled();
    });

    it("returns 503 when workspace service is not available", async () => {
      const response = await callRoute(
        "POST",
        "/api/workspace/ws-123/commit",
        { message: "valid message" },
        createRouteContext(null),
      );

      expect(response.handled).toBe(true);
      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: "Workspace Service not available",
      });
      expect(commit).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/workspace/provision", () => {
    it("provisions a workspace with valid repo", async () => {
      const response = await callRoute("POST", "/api/workspace/provision", {
        repo: "owner/repo",
        branchName: "feature",
      });

      expect(response.handled).toBe(true);
      expect(response.status).toBe(201);
      expect(provisionWorkspace).toHaveBeenCalledWith({
        repo: "owner/repo",
        branchName: "feature",
      });
    });

    it("rejects missing repo with 400", async () => {
      const response = await callRoute("POST", "/api/workspace/provision", {});

      expect(response.handled).toBe(true);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "repo is required" });
    });
  });

  describe("POST /api/workspace/:id/pr", () => {
    it("creates a PR with valid title and body", async () => {
      const response = await callRoute("POST", "/api/workspace/ws-123/pr", {
        title: "PR Title",
        body: "PR Description",
      });

      expect(response.handled).toBe(true);
      expect(response.status).toBe(201);
      expect(createPR).toHaveBeenCalledWith("ws-123", {
        title: "PR Title",
        body: "PR Description",
      });
    });

    it.each([
      ["missing body", { title: "Title" }],
      ["missing title", { body: "Body" }],
      ["empty title", { title: "", body: "Body" }],
      ["empty body", { title: "Title", body: "" }],
    ])("rejects %s with 400", async (_desc, body) => {
      const response = await callRoute(
        "POST",
        "/api/workspace/ws-123/pr",
        body,
      );

      expect(response.handled).toBe(true);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "title and body are required" });
    });
  });

  describe("GET /api/workspace/:id", () => {
    it("returns workspace status", async () => {
      const response = await callRoute("GET", "/api/workspace/ws-123");

      expect(response.handled).toBe(true);
      expect(response.status).toBe(200);
      expect(getStatus).toHaveBeenCalledWith("ws-123");
    });
  });

  describe("DELETE /api/workspace/:id", () => {
    it("deletes a workspace", async () => {
      const response = await callRoute("DELETE", "/api/workspace/ws-123");

      expect(response.handled).toBe(true);
      expect(response.status).toBe(200);
      expect(removeWorkspace).toHaveBeenCalledWith("ws-123");
      expect(response.body).toEqual({ success: true, workspaceId: "ws-123" });
    });
  });
});
