/**
 * W1-026 route-level password gate for `POST /api/agent/import`: the raw
 * frame's declared password length is bounded by the 12-character minimum
 * before any bytes reach `importAgent`. The transport (req stream, json/error
 * responders) and the export/import helpers are mocked; the route handler is
 * real.
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
