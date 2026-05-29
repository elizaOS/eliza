import type { IncomingMessage, ServerResponse } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import type { AcpActionService } from "../actions/common.js";
import type { CodingWorkspaceService } from "../services/workspace-service.js";

export interface RouteContext {
  runtime: IAgentRuntime;
  acpService: AcpActionService | null;
  workspaceService: CodingWorkspaceService | null;
}

// Max request body size (1 MB)
const MAX_BODY_SIZE = 1024 * 1024;

/**
 * Parse the JSON request body.
 *
 * The elizaOS runtime route dispatcher parses JSON bodies and attaches the
 * result to `req.body` before invoking `rawPath` handlers (see
 * `@elizaos/core` `readJsonBody`), draining the request stream in the process.
 * Re-reading that already-ended stream would hang forever, so we return the
 * pre-parsed body when present and only fall back to reading the stream for
 * direct callers (e.g. unit tests) that pass an unconsumed request.
 */
export async function parseBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const preParsed = (req as IncomingMessage & { body?: unknown }).body;
  if (preParsed != null) {
    if (typeof preParsed === "object" && !Array.isArray(preParsed)) {
      return preParsed as Record<string, unknown>;
    }
    throw new Error("Invalid JSON body");
  }

  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer | string) => {
      size += typeof chunk === "string" ? chunk.length : chunk.byteLength;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// Helper to send JSON response
export function sendJson(
  res: ServerResponse,
  data: unknown,
  status = 200,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// Helper to send error
export function sendError(
  res: ServerResponse,
  message: string,
  status = 400,
): void {
  sendJson(res, { error: message }, status);
}
