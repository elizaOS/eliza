/**
 * Exercises compatibility approval decisions with real Node request/response
 * objects and a deterministic computer-use service.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/core")>()),
  resolveAliasedEnvValue: () => undefined,
}));

const { handleComputerUseCompatRoutes } = await import(
  "./computer-use-compat-routes.js"
);

interface CapturedResponse {
  statusCode?: number;
  body?: string;
  resolveApproval: ReturnType<typeof vi.fn>;
}

async function request(pathname: string): Promise<CapturedResponse> {
  const captured: Omit<CapturedResponse, "resolveApproval"> = {};
  const resolveApproval = vi.fn(() => null);
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  const req = new IncomingMessage(socket);
  // Bun does not retain the constructor socket on synthetic IncomingMessage
  // instances, so bind the proven loopback peer explicitly for this auth test.
  Object.defineProperty(req, "socket", { value: socket, configurable: true });
  req.method = "POST";
  req.url = pathname;
  Object.defineProperty(req, "headers", { value: {}, configurable: true });
  (req as IncomingMessage & { body?: unknown }).body = { approved: true };
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

describe("computer-use compatibility approval path decoding", () => {
  it("decodes a valid approval id before service resolution", async () => {
    const response = await request("/api/computer-use/approvals/approval%2D1");

    expect(response.statusCode).toBe(404);
    expect(response.resolveApproval).toHaveBeenCalledWith(
      "approval-1",
      true,
      undefined,
    );
  });

  it.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed segment %s before service resolution",
    async (segment) => {
      const response = await request(`/api/computer-use/approvals/${segment}`);

      expect(response.statusCode).toBe(400);
      expect(response.resolveApproval).not.toHaveBeenCalled();
      expect(JSON.parse(response.body ?? "")).toEqual({
        error: "Invalid approval id: malformed URL encoding",
      });
    },
  );
});
