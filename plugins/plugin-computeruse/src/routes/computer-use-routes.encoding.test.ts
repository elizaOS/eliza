/**
 * Computer-use approval-id path encoding is leftover tax after apps /
 * scheduling percent-encoding Fixes. Stock develop called
 * decodeURIComponent on POST /api/computer-use/approvals/:id, so `%` /
 * `%2` / `%ZZ` threw URIError (500) instead of a typed 400. List /
 * stream / approval-mode stay untouched.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { handleComputerUseRoutes } from "./computer-use-routes.ts";

interface CapturedResponse {
  statusCode?: number;
  body?: string;
  ended: boolean;
}

async function hit(
  pathname: string,
  method = "POST",
): Promise<CapturedResponse> {
  const captured: CapturedResponse = { ended: false };
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  const req = new IncomingMessage(socket);
  req.method = method;
  const res = new ServerResponse(req);
  res.statusCode = 0;
  res.end = function end(
    this: ServerResponse,
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): ServerResponse {
    captured.ended = true;
    captured.body = typeof chunk === "string" ? chunk : "";
    captured.statusCode = this.statusCode;
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return this;
  };
  await handleComputerUseRoutes(req, res, pathname, method);
  return captured;
}

describe("POST /api/computer-use/approvals/:id encoding", () => {
  it("canonical approval id still 404s as not pending", async () => {
    const res = await hit("/api/computer-use/approvals/approval-1");
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? "")).toEqual({
      error: "Computer-use approval is not pending.",
      id: "approval-1",
    });
  });

  it("canonical percent-encoded hyphen still decodes before the 404", async () => {
    const res = await hit("/api/computer-use/approvals/demo%2Did");
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? "")).toEqual({
      error: "Computer-use approval is not pending.",
      id: "demo-id",
    });
  });

  it("GET approvals list is untouched", async () => {
    const res = await hit("/api/computer-use/approvals", "GET");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toMatchObject({
      mode: "full_control",
      pendingCount: 0,
    });
  });

  it.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed approval id %s with 400",
    async (token) => {
      const res = await hit(`/api/computer-use/approvals/${token}`);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body ?? "")).toEqual({
        error: "Invalid approval id: malformed URL encoding",
      });
    },
  );
});
