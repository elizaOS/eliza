/**
 * Byte, depth, and node budget for attacker-controlled MCP JSON Schema.
 *
 * Shared by Ajv compile (`validateJsonSchema`) and the tool-compatibility
 * rewrite so a cyclic or deeply nested `inputSchema` cannot stack-overflow
 * the agent event loop. This module has no Ajv import.
 */
import { ElizaError } from "@elizaos/core/errors";

export const MAX_MCP_SCHEMA_JSON_BYTES = 256 * 1024;
export const MAX_MCP_SCHEMA_DEPTH = 32;
export const MAX_MCP_SCHEMA_NODES = 2048;

/** Stable code when a tool `inputSchema` exceeds the MCP schema budget. */
export const MCP_TOOL_SCHEMA_UNBOUNDED = "MCP_TOOL_SCHEMA_UNBOUNDED";

function walkSchema(node: unknown, depth: number, acc: { nodes: number }): string | undefined {
  if (depth > MAX_MCP_SCHEMA_DEPTH) {
    return `MCP JSON schema nesting depth exceeds ${MAX_MCP_SCHEMA_DEPTH}`;
  }
  if (node === null || typeof node !== "object") {
    return undefined;
  }

  acc.nodes += 1;
  if (acc.nodes > MAX_MCP_SCHEMA_NODES) {
    return `MCP JSON schema node count exceeds ${MAX_MCP_SCHEMA_NODES}`;
  }

  if (!Array.isArray(node) && (node as Record<string, unknown>).$async === true) {
    return "MCP JSON schema uses unsupported asynchronous validation";
  }

  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const error = walkSchema(value, depth + 1, acc);
    if (error) {
      return error;
    }
  }
  return undefined;
}

export function getMcpJsonSchemaBudgetError(schema: unknown): string | undefined {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    // error-policy:J3 schema preflight returns an explicit invalid result below
    return "MCP JSON schema is not JSON-serializable";
  }

  if (serialized === undefined) {
    return "MCP JSON schema is not JSON-serializable";
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_MCP_SCHEMA_JSON_BYTES) {
    return `MCP JSON schema serialized size ${bytes} exceeds ${MAX_MCP_SCHEMA_JSON_BYTES}`;
  }

  return walkSchema(schema, 0, { nodes: 0 });
}

/**
 * Fail closed before any recursive MCP schema walk.
 */
export function assertMcpJsonSchemaBudget(schema: unknown): void {
  const error = getMcpJsonSchemaBudgetError(schema);
  if (error) {
    throw new ElizaError(error, {
      code: MCP_TOOL_SCHEMA_UNBOUNDED,
      context: { reason: error },
      severity: "fatal",
    });
  }
}
