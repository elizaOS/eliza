/**
 * Compat computer-use approval-id path encoding is leftover tax after
 * computer-use-routes (#21326). Stock develop called decodeURIComponent
 * on POST /api/computer-use/approvals/:id, so `%` / `%2` / `%ZZ` threw
 * URIError (500) instead of a typed 400. List / stream / approval-mode
 * stay untouched.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  resolveAliasedEnvValue: () => undefined,
}));

const { handleComputerUseCompatRoutes } = await import(
  "./computer-use-compat-routes.ts"
);

interface CapturedResponse {
  statusCode?: number;
  body?: string;
  ended: boolean;
}

async function hit(
  pathname: string,
  method = "POST",
  body: Record<string, unknown> = { approved: true },
): Promise<CapturedResponse & { resolveApproval: ReturnType<typeof vi.fn> }> {
  const captured: CapturedResponse = { ended: false };
  const resolveApproval = vi.fn(() => null);
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = pathname;
  (req as IncomingMessage & { body?: unknown }).body = body;
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
  await handleComputerUseCompatRoutes(req, res, {
    current: {
      getService: () => ({
        getApprovalSnapshot: () => ({
          mode: "full_control",
          pendingCount: 0,
          pendingApprovals: [],
        }),
        setApprovalMode: (mode: string) => mode,
        resolveApproval,
      }),
    },
  });
  return { ...captured, resolveApproval };
}

describe("compat POST /api/computer-use/approvals/:id encoding", () => {
  it("canonical approval id still 404s as not found", async () => {
    const res = await hit("/api/computer-use/approvals/approval-1");
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? "")).toEqual({
      error: "Approval not found",
    });
    expect(res.resolveApproval).toHaveBeenCalledWith(
      "approval-1",
      true,
      undefined,
    );
  });

  it("canonical percent-encoded hyphen still decodes before the 404", async () => {
    const res = await hit("/api/computer-use/approvals/demo%2Did");
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? "")).toEqual({
      error: "Approval not found",
    });
    expect(res.resolveApproval).toHaveBeenCalledWith("demo-id", true, undefined);
  });

  it("GET approvals list is untouched", async () => {
    const res = await hit("/api/computer-use/approvals", "GET");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "")).toMatchObject({
      mode: "full_control",
      pendingCount: 0,
    });
    expect(res.resolveApproval).not.toHaveBeenCalled();
  });

  it.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed approval id %s with 400",
    async (token) => {
      const res = await hit(`/api/computer-use/approvals/${token}`);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body ?? "")).toEqual({
        error: "Invalid approval id: malformed URL encoding",
      });
      expect(res.resolveApproval).not.toHaveBeenCalled();
    },
  );
});
