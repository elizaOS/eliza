/**
 * Unit tests for agent export, import, and size estimation HTTP routes:
 * password length constraints, binary frame parsing, streaming download headers,
 * runtime availability gates, and boundary error translation.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentTransferRouteContext,
  handleAgentTransferRoutes,
} from "./agent-transfer-routes.ts";

function importFrame(password: string, fileBytes: Buffer): Buffer {
  const passwordBytes = Buffer.from(password, "utf-8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(passwordBytes.length, 0);
  return Buffer.concat([head, passwordBytes, fileBytes]);
}

function requestWithBody(body: Buffer): http.IncomingMessage {
  const stream = new Readable({ read() {} });
  stream.push(body);
  stream.push(null);
  return stream as unknown as http.IncomingMessage;
}

/** Test double matching the generic readJsonBody route-helper signature. */
function mockReadJsonBody<T extends object>(
  body: T,
): AgentTransferRouteContext["readJsonBody"] {
  return async <U extends object>() => body as unknown as U | null;
}

function createFakeResponse(): http.ServerResponse & {
  body: unknown;
  headers: Record<string, string | number>;
  statusCode: number;
} {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string | number>,
    body: null as unknown,
    setHeader: vi.fn((key: string, value: string | number) => {
      res.headers[key.toLowerCase()] = value;
      return res;
    }),
    end: vi.fn((chunk?: unknown) => {
      res.body = chunk;
      return res;
    }),
  };
  return res as unknown as http.ServerResponse & {
    body: unknown;
    headers: Record<string, string | number>;
    statusCode: number;
  };
}

function routeContext(
  password: string,
  importAgent: AgentTransferRouteContext["importAgent"],
  error: AgentTransferRouteContext["error"],
  json: AgentTransferRouteContext["json"],
): AgentTransferRouteContext {
  return {
    req: requestWithBody(importFrame(password, Buffer.from("file-bytes"))),
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/agent/import",
    state: { runtime: {} as AgentRuntime },
    readJsonBody: vi.fn(async () => null),
    json,
    error,
    exportAgent: vi.fn(async () => Buffer.alloc(0)),
    estimateExportSize: vi.fn(async () => ({})),
    importAgent,
    isAgentExportError: () => false,
  };
}

describe("handleAgentTransferRoutes import password minimum (W1-026)", () => {
  it("rejects a declared password below 12 characters with 400", async () => {
    const error = vi.fn();
    const json = vi.fn();
    const importAgent = vi.fn(async () => ({ success: true }));

    const handled = await handleAgentTransferRoutes(
      routeContext("12345678901", importAgent, error, json),
    );

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("at least 12 characters"),
      400,
    );
    expect(importAgent).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("passes a 12-character password through to importAgent", async () => {
    const error = vi.fn();
    const json = vi.fn();
    const importAgent = vi.fn(async () => ({ success: true }));

    const handled = await handleAgentTransferRoutes(
      routeContext("123456789012", importAgent, error, json),
    );

    expect(handled).toBe(true);
    expect(importAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Buffer),
      "123456789012",
    );
    expect(json).toHaveBeenCalledWith(expect.anything(), { success: true });
    expect(error).not.toHaveBeenCalled();
  });
});

describe("handleAgentTransferRoutes routing", () => {
  it("returns false for non-matching paths", async () => {
    const res = createFakeResponse();
    const handled = await handleAgentTransferRoutes({
      req: {} as http.IncomingMessage,
      res,
      method: "GET",
      pathname: "/api/other/path",
      state: { runtime: null },
      readJsonBody: vi.fn(async () => null),
      json: vi.fn(),
      error: vi.fn(),
      exportAgent: vi.fn(async () => Buffer.alloc(0)),
      estimateExportSize: vi.fn(async () => ({})),
      importAgent: vi.fn(async () => ({})),
      isAgentExportError: () => false,
    });
    expect(handled).toBe(false);
  });
});

describe("POST /api/agent/export", () => {
  it("rejects with 503 when runtime is not running", async () => {
    const error = vi.fn();
    const res = createFakeResponse();
    const handled = await handleAgentTransferRoutes({
      req: {} as http.IncomingMessage,
      res,
      method: "POST",
      pathname: "/api/agent/export",
      state: { runtime: null },
      readJsonBody: vi.fn(async () => null),
      json: vi.fn(),
      error,
      exportAgent: vi.fn(async () => Buffer.alloc(0)),
      estimateExportSize: vi.fn(async () => ({})),
      importAgent: vi.fn(async () => ({})),
      isAgentExportError: () => false,
    });

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      res,
      "Agent is not running — start it before exporting.",
      503,
    );
  });

  it("validates request schema and streams encrypted bundle as download", async () => {
    const res = createFakeResponse();
    const fakeBuffer = Buffer.from("encrypted-bundle-data");
    const exportAgent = vi.fn(async () => fakeBuffer);
    const fakeRuntime = {
      character: { name: "Special Agent" },
    } as unknown as AgentRuntime;

    const handled = await handleAgentTransferRoutes({
      req: {} as http.IncomingMessage,
      res,
      method: "POST",
      pathname: "/api/agent/export",
      state: { runtime: fakeRuntime },
      readJsonBody: mockReadJsonBody({
        password: "long-secure-password-123",
        includeLogs: true,
      }),
      json: vi.fn(),
      error: vi.fn(),
      exportAgent,
      estimateExportSize: vi.fn(async () => ({})),
      importAgent: vi.fn(async () => ({})),
      isAgentExportError: () => false,
    });

    expect(handled).toBe(true);
    expect(exportAgent).toHaveBeenCalledWith(
      fakeRuntime,
      "long-secure-password-123",
      { includeLogs: true },
    );
    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/octet-stream",
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      expect.stringMatching(
        /^attachment; filename="special_agent-.*\.eliza-agent"$/,
      ),
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Length",
      fakeBuffer.length,
    );
    expect(res.end).toHaveBeenCalledWith(fakeBuffer);
  });

  it("translates domain export errors to 400 and generic errors to 500", async () => {
    const error = vi.fn();
    const res = createFakeResponse();
    const fakeRuntime = {
      character: { name: "Agent" },
    } as unknown as AgentRuntime;

    await handleAgentTransferRoutes({
      req: {} as http.IncomingMessage,
      res,
      method: "POST",
      pathname: "/api/agent/export",
      state: { runtime: fakeRuntime },
      readJsonBody: mockReadJsonBody({
        password: "long-secure-password-123",
      }),
      json: vi.fn(),
      error,
      exportAgent: vi
        .fn()
        .mockRejectedValue(new Error("Corrupt export header")),
      estimateExportSize: vi.fn(async () => ({})),
      importAgent: vi.fn(async () => ({})),
      isAgentExportError: (err) =>
        err instanceof Error && err.message.includes("Corrupt"),
    });

    expect(error).toHaveBeenCalledWith(res, "Corrupt export header", 400);

    error.mockReset();
    await handleAgentTransferRoutes({
      req: {} as http.IncomingMessage,
      res,
      method: "POST",
      pathname: "/api/agent/export",
      state: { runtime: fakeRuntime },
      readJsonBody: mockReadJsonBody({
        password: "long-secure-password-123",
      }),
      json: vi.fn(),
      error,
      exportAgent: vi.fn().mockRejectedValue(new Error("Disk failure")),
      estimateExportSize: vi.fn(async () => ({})),
      importAgent: vi.fn(async () => ({})),
      isAgentExportError: () => false,
    });

    expect(error).toHaveBeenCalledWith(res, "Export failed: Disk failure", 500);
  });
});

describe("GET /api/agent/export/estimate", () => {
  it("rejects with 503 when runtime is not running", async () => {
    const error = vi.fn();
    const res = createFakeResponse();
    const handled = await handleAgentTransferRoutes({
      req: {} as http.IncomingMessage,
      res,
      method: "GET",
      pathname: "/api/agent/export/estimate",
      state: { runtime: null },
      readJsonBody: vi.fn(async () => null),
      json: vi.fn(),
      error,
      exportAgent: vi.fn(async () => Buffer.alloc(0)),
      estimateExportSize: vi.fn(async () => ({})),
      importAgent: vi.fn(async () => ({})),
      isAgentExportError: () => false,
    });

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(res, "Agent is not running.", 503);
  });

  it("returns estimate JSON when runtime is running", async () => {
    const json = vi.fn();
    const res = createFakeResponse();
    const fakeRuntime = {
      character: { name: "Agent" },
    } as unknown as AgentRuntime;
    const estimateResult = { totalBytes: 1024, memoryBytes: 512 };

    const handled = await handleAgentTransferRoutes({
      req: {} as http.IncomingMessage,
      res,
      method: "GET",
      pathname: "/api/agent/export/estimate",
      state: { runtime: fakeRuntime },
      readJsonBody: vi.fn(async () => null),
      json,
      error: vi.fn(),
      exportAgent: vi.fn(async () => Buffer.alloc(0)),
      estimateExportSize: vi.fn(async () => estimateResult),
      importAgent: vi.fn(async () => ({})),
      isAgentExportError: () => false,
    });

    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledWith(res, estimateResult);
  });
});

describe("POST /api/agent/import frame boundaries", () => {
  it("rejects body too small with 400", async () => {
    const error = vi.fn();
    const res = createFakeResponse();
    const fakeRuntime = {} as AgentRuntime;

    const handled = await handleAgentTransferRoutes({
      req: requestWithBody(Buffer.from([0, 0, 0])),
      res,
      method: "POST",
      pathname: "/api/agent/import",
      state: { runtime: fakeRuntime },
      readJsonBody: vi.fn(async () => null),
      json: vi.fn(),
      error,
      exportAgent: vi.fn(async () => Buffer.alloc(0)),
      estimateExportSize: vi.fn(async () => ({})),
      importAgent: vi.fn(async () => ({})),
      isAgentExportError: () => false,
    });

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      res,
      "Request body is too small — expected password + file data.",
      400,
    );
  });

  it("rejects password exceeding max length with 400", async () => {
    const error = vi.fn();
    const res = createFakeResponse();
    const fakeRuntime = {} as AgentRuntime;
    const longPassword = "a".repeat(1025);

    const handled = await handleAgentTransferRoutes({
      req: requestWithBody(importFrame(longPassword, Buffer.from("data"))),
      res,
      method: "POST",
      pathname: "/api/agent/import",
      state: { runtime: fakeRuntime },
      readJsonBody: vi.fn(async () => null),
      json: vi.fn(),
      error,
      exportAgent: vi.fn(async () => Buffer.alloc(0)),
      estimateExportSize: vi.fn(async () => ({})),
      importAgent: vi.fn(async () => ({})),
      isAgentExportError: () => false,
    });

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      res,
      "Password is too long (max 1024 bytes).",
      400,
    );
  });

  it("rejects partial body missing file data with 400", async () => {
    const error = vi.fn();
    const res = createFakeResponse();
    const fakeRuntime = {} as AgentRuntime;
    const validPassword = "securepassword123";

    // Frame with password but zero file bytes
    const passwordBytes = Buffer.from(validPassword, "utf-8");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(passwordBytes.length, 0);
    const partialFrame = Buffer.concat([head, passwordBytes]);

    const handled = await handleAgentTransferRoutes({
      req: requestWithBody(partialFrame),
      res,
      method: "POST",
      pathname: "/api/agent/import",
      state: { runtime: fakeRuntime },
      readJsonBody: vi.fn(async () => null),
      json: vi.fn(),
      error,
      exportAgent: vi.fn(async () => Buffer.alloc(0)),
      estimateExportSize: vi.fn(async () => ({})),
      importAgent: vi.fn(async () => ({})),
      isAgentExportError: () => false,
    });

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      res,
      "Request body is partial — missing file data after password.",
      400,
    );
  });
});
