import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import type { RouteRequestContext } from "@elizaos/shared";
import { readRequestBodyBuffer } from "@elizaos/core";

const MAX_IMPORT_BYTES = 512 * 1_048_576;
const AGENT_TRANSFER_MIN_PASSWORD_LENGTH = 4;
const AGENT_TRANSFER_MAX_PASSWORD_LENGTH = 1024;

function readRawBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return readRequestBodyBuffer(req, { maxBytes }).then(
    (body: Buffer | null) => {
      if (body === null) {
        throw new Error(
          `Request body exceeds maximum size (${maxBytes} bytes)`,
        );
      }
      return body;
    },
  );
}

export interface AgentTransferRouteState {
  runtime: AgentRuntime | null;
}

export interface AgentTransferRouteContext extends RouteRequestContext {
  state: AgentTransferRouteState;
  exportAgent: (
    runtime: AgentRuntime,
    password: string,
    options: { includeLogs: boolean },
  ) => Promise<Buffer>;
  estimateExportSize: (runtime: AgentRuntime) => Promise<unknown>;
  importAgent: (
    runtime: AgentRuntime,
    fileBuffer: Buffer,
    password: string,
  ) => Promise<unknown>;
  isAgentExportError: (error: unknown) => boolean;
}

export async function handleAgentTransferRoutes(
  ctx: AgentTransferRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    state,
    readJsonBody,
    json,
    error,
    exportAgent,
    estimateExportSize,
    importAgent,
    isAgentExportError,
  } = ctx;

  if (method === "POST" && pathname === "/api/agent/export") {
    if (!state.runtime) {
      error(res, "Agent is not running — start it before exporting.", 503);
      return true;
    }

    const body = await readJsonBody<{
      password?: string;
      includeLogs?: boolean;
    }>(req, res);
    if (!body) return true;

    if (!body.password || typeof body.password !== "string") {
      error(
        res,
        `A password of at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters is required.`,
        400,
      );
      return true;
    }

    if (body.password.length < AGENT_TRANSFER_MIN_PASSWORD_LENGTH) {
      error(
        res,
        `A password of at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters is required.`,
        400,
      );
      return true;
    }

    try {
      const fileBuffer = await exportAgent(state.runtime, body.password, {
        includeLogs: body.includeLogs === true,
      });

      const agentName = (state.runtime.character.name ?? "agent")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .toLowerCase();
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const filename = `${agentName}-${timestamp}.eliza-agent`;

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.setHeader("Content-Length", fileBuffer.length);
      res.end(fileBuffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAgentExportError(err)) {
        error(res, message, 400);
      } else {
        error(res, `Export failed: ${message}`, 500);
      }
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/agent/export/estimate") {
    if (!state.runtime) {
      error(res, "Agent is not running.", 503);
      return true;
    }

    try {
      const estimate = await estimateExportSize(state.runtime);
      json(res, estimate as Record<string, unknown>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(res, `Estimate failed: ${message}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/agent/import") {
    if (!state.runtime) {
      error(res, "Agent is not running — start it before importing.", 503);
      return true;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(req, MAX_IMPORT_BYTES);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(res, message, 413);
      return true;
    }

    if (rawBody.length < 5) {
      error(
        res,
        "Request body is too small — expected password + file data.",
        400,
      );
      return true;
    }

    const passwordLength = rawBody.readUInt32BE(0);
    if (passwordLength < AGENT_TRANSFER_MIN_PASSWORD_LENGTH) {
      error(
        res,
        `Password must be at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters.`,
        400,
      );
      return true;
    }
    if (passwordLength > AGENT_TRANSFER_MAX_PASSWORD_LENGTH) {
      error(
        res,
        `Password is too long (max ${AGENT_TRANSFER_MAX_PASSWORD_LENGTH} bytes).`,
        400,
      );
      return true;
    }
    if (rawBody.length < 4 + passwordLength + 1) {
      error(
        res,
        "Request body is incomplete — missing file data after password.",
        400,
      );
      return true;
    }

    const password = rawBody.subarray(4, 4 + passwordLength).toString("utf-8");
    const fileBuffer = rawBody.subarray(4 + passwordLength);

    try {
      const result = await importAgent(state.runtime, fileBuffer, password);
      json(res, result as Record<string, unknown>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAgentExportError(err)) {
        error(res, message, 400);
      } else {
        error(res, `Import failed: ${message}`, 500);
      }
    }
    return true;
  }

  return false;
}
