import type { IncomingMessage, ServerResponse } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import type { PTYService } from "../services/pty-service.js";
import type { SwarmCoordinator } from "../services/swarm-coordinator.js";
import type { CodingWorkspaceService } from "../services/workspace-service.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface RouteContext {
  runtime: IAgentRuntime;
  ptyService: PTYService | null;
  workspaceService: CodingWorkspaceService | null;
  coordinator?: SwarmCoordinator;
}

// Max request body size (1 MB)
const MAX_BODY_SIZE = 1024 * 1024;

// Helper to parse JSON body with size limit
export async function parseBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
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
