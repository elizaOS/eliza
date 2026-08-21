/**
 * Exercises canonical approval decisions with real Node request/response
 * objects, including malformed URL path segments.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { handleComputerUseRoutes } from "./computer-use-routes.js";

interface CapturedResponse {
  statusCode?: number;
  body?: string;
}

async function request(pathname: string): Promise<CapturedResponse> {
  const captured: CapturedResponse = {};
  const req = new IncomingMessage(new Socket());
  req.method = "POST";
  const res = new ServerResponse(req);
  res.end = function end(
    this: ServerResponse,
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): ServerResponse {
    captured.body = typeof chunk === "string" ? chunk : "";
    captured.statusCode = this.statusCode;
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return this;
  };
  await handleComputerUseRoutes(req, res, pathname, "POST");
  return captured;
}

describe("computer-use approval path decoding", () => {
  it("decodes a valid approval id", async () => {
    const response = await request("/api/computer-use/approvals/approval%2D1");

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body ?? "")).toEqual({
      error: "Computer-use approval is not pending.",
      id: "approval-1",
    });
  });

  it.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed segment %s",
    async (segment) => {
      const response = await request(`/api/computer-use/approvals/${segment}`);

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body ?? "")).toEqual({
        error: "Invalid approval id: malformed URL encoding",
      });
    },
  );
});
