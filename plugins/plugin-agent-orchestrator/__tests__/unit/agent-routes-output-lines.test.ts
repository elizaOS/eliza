/**
 * GET /api/coding-agents/:id/output untrusted `lines` query contract.
 *
 * Stock parseInt prefix-coerces 1e2→1 and 12px→12, so getSessionOutput
 * returns the wrong page of ACP output. Non-numeric tokens fail open to 100.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleAgentRoutes } from "../../src/api/agent-routes.ts";
import type { RouteContext } from "../../src/api/route-utils.ts";

function fakeRequest(url: string): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage;
  (emitter as { method: string }).method = "GET";
  (emitter as { url: string }).url = url;
  (emitter as { headers: { host: string } }).headers = { host: "127.0.0.1" };
  queueMicrotask(() => {
    emitter.emit("end");
  });
  return emitter;
}

function fakeResponse(): {
  res: ServerResponse;
  status: () => number;
  body: () => unknown;
} {
  const writes: Buffer[] = [];
  let statusCode = 0;
  const res = {
    writeHead(code: number) {
      statusCode = code;
    },
    end(chunk?: Buffer | string) {
      if (chunk) {
        writes.push(Buffer.from(typeof chunk === "string" ? chunk : chunk));
      }
      (res as { writableEnded: boolean }).writableEnded = true;
    },
    writableEnded: false,
  } as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode,
    body: () => {
      const merged = Buffer.concat(writes).toString("utf8");
      if (!merged) return null;
      try {
        return JSON.parse(merged);
      } catch {
        return merged;
      }
    },
  };
}

type AcpMock = NonNullable<RouteContext["acpService"]>;

function makeCtx(getSessionOutput: AcpMock["getSessionOutput"]): RouteContext {
  return {
    runtime: {} as unknown as RouteContext["runtime"],
    acpService: { getSessionOutput } as unknown as AcpMock,
    workspaceService: null,
  };
}

async function getOutput(url: string, getSessionOutput = vi.fn()) {
  const ctx = makeCtx(getSessionOutput);
  const req = fakeRequest(url);
  const { res, status, body } = fakeResponse();
  const handled = await handleAgentRoutes(
    req,
    res,
    "/api/coding-agents/sess-1/output",
    ctx,
  );
  return { handled, status: status(), body: body(), getSessionOutput };
}

describe("GET /api/coding-agents/:id/output lines query", () => {
  it("omitted lines uses the documented default 100", async () => {
    const getSessionOutput = vi.fn().mockResolvedValue("ok");
    const result = await getOutput(
      "/api/coding-agents/sess-1/output",
      getSessionOutput,
    );

    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    // Named bounded tail (cap-audit): the response now declares the tail
    // window explicitly instead of presenting it as the whole output.
    expect(result.body).toEqual({
      sessionId: "sess-1",
      output: "ok",
      tail: true,
      lines: 100,
    });
    expect(getSessionOutput).toHaveBeenCalledWith("sess-1", 100);
  });

  it("canonical lines=50 reaches getSessionOutput", async () => {
    const getSessionOutput = vi.fn().mockResolvedValue("page");
    const result = await getOutput(
      "/api/coding-agents/sess-1/output?lines=50",
      getSessionOutput,
    );

    expect(result.status).toBe(200);
    expect(getSessionOutput).toHaveBeenCalledWith("sess-1", 50);
  });

  it.each([
    "1e2",
    "12px",
    "007",
    "0",
    "-1",
    "0x10",
    "abc",
    "50abc",
    "2001",
    "9007199254740991",
  ])(
    "rejects prefix-coerced or junk lines=%s with 400 before getSessionOutput",
    async (token) => {
      const getSessionOutput = vi.fn().mockResolvedValue("must-not-run");
      const result = await getOutput(
        `/api/coding-agents/sess-1/output?lines=${token}`,
        getSessionOutput,
      );

      expect(result.handled).toBe(true);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: "lines must be an integer from 1 to 2000",
      });
      expect(getSessionOutput).not.toHaveBeenCalled();
    },
  );

  it("accepts the full retained 2000-line buffer", async () => {
    const getSessionOutput = vi.fn().mockResolvedValue("full buffer");
    const result = await getOutput(
      "/api/coding-agents/sess-1/output?lines=2000",
      getSessionOutput,
    );

    expect(result.status).toBe(200);
    expect(getSessionOutput).toHaveBeenCalledWith("sess-1", 2_000);
  });
});
