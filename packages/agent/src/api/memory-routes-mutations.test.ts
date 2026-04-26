import type http from "node:http";
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  handleMemoryRoutes,
  type MemoryRouteContext,
} from "./memory-routes.js";

interface CapturedResponse {
  status: number;
  body: unknown;
}

const MEMORY_ID = "11111111-2222-3333-4444-555555555555" as UUID;
const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;

function makeRuntime(overrides: Partial<AgentRuntime>): AgentRuntime {
  return {
    agentId: AGENT_ID,
    character: { name: "Milady" },
    ensureConnection: vi.fn(async () => {}),
    ...overrides,
  } as unknown as AgentRuntime;
}

function makeContext(params: {
  method: string;
  pathname: string;
  runtime: AgentRuntime;
  body?: object | null;
}): { ctx: MemoryRouteContext; capture: CapturedResponse } {
  const capture: CapturedResponse = { status: 200, body: null };
  const req = {
    method: params.method,
    url: params.pathname,
  } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const url = new URL(params.pathname, "http://localhost");

  return {
    capture,
    ctx: {
      req,
      res,
      method: params.method,
      pathname: params.pathname,
      url,
      runtime: params.runtime,
      agentName: "Milady",
      json: (_res, data, status = 200) => {
        capture.status = status;
        capture.body = data;
      },
      error: (_res, message, status = 400) => {
        capture.status = status;
        capture.body = { error: message };
      },
      readJsonBody: async () => (params.body ?? null) as never,
    },
  };
}

describe("handleMemoryRoutes memory mutations", () => {
  it("deletes an existing memory by id", async () => {
    const existing = {
      id: MEMORY_ID,
      content: { text: "old note" },
    } as Memory;
    const deleteMemory = vi.fn(async () => {});
    const runtime = makeRuntime({
      getMemoryById: vi.fn(async () => existing),
      deleteMemory,
    });
    const { ctx, capture } = makeContext({
      method: "DELETE",
      pathname: `/api/memories/${MEMORY_ID}`,
      runtime,
    });

    const handled = await handleMemoryRoutes(ctx);

    expect(handled).toBe(true);
    expect(deleteMemory).toHaveBeenCalledWith(MEMORY_ID);
    expect(capture.status).toBe(200);
    expect(capture.body).toEqual({ deleted: true, id: MEMORY_ID });
  });

  it("updates memory text and regenerates the embedding before persisting", async () => {
    const existing = {
      id: MEMORY_ID,
      content: { text: "old note", source: "test" },
    } as Memory;
    const updated = {
      id: MEMORY_ID,
      content: { text: "new note", source: "test" },
    } as Memory;
    const getMemoryById = vi
      .fn()
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(updated);
    const updateMemory = vi.fn(async () => {});
    const runtime = makeRuntime({
      getMemoryById,
      updateMemory,
      useModel: vi.fn(async () => [0.1, 0.2, 0.3]),
    });
    const { ctx, capture } = makeContext({
      method: "PATCH",
      pathname: `/api/memories/${MEMORY_ID}`,
      runtime,
      body: { text: "new note" },
    });

    const handled = await handleMemoryRoutes(ctx);

    expect(handled).toBe(true);
    expect(updateMemory).toHaveBeenCalledWith({
      id: MEMORY_ID,
      content: { text: "new note", source: "test" },
      embedding: [0.1, 0.2, 0.3],
    });
    expect(capture.status).toBe(200);
    expect(capture.body).toEqual({
      updated: true,
      id: MEMORY_ID,
      memory: updated,
    });
  });
});
