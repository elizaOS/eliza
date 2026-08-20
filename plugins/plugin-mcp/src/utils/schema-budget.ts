/**
 * Byte, depth, and node budget for attacker-controlled MCP JSON Schema.
 *
 * Shared by Ajv compile (`validateJsonSchema`) and the tool-compatibility
 * rewrite so a cyclic or deeply nested `inputSchema` cannot stack-overflow
 * the agent event loop. This module has no Ajv import.
 */
import { ElizaError } from "@elizaos/core";

export const MAX_MCP_SCHEMA_JSON_BYTES = 256 * 1024;
export const MAX_MCP_SCHEMA_DEPTH = 32;
export const MAX_MCP_SCHEMA_NODES = 2048;

/** Stable code when a tool `inputSchema` exceeds the MCP schema budget. */
export const MCP_TOOL_SCHEMA_UNBOUNDED = "MCP_TOOL_SCHEMA_UNBOUNDED";

interface SchemaBudgetAccumulator {
  nodes: number;
  serializedBytes: number;
  seen: WeakSet<object>;
}

function addSerializedBytes(bytes: number, acc: SchemaBudgetAccumulator): string | undefined {
  acc.serializedBytes += bytes;
  if (acc.serializedBytes > MAX_MCP_SCHEMA_JSON_BYTES) {
    return `MCP JSON schema serialized size exceeds ${MAX_MCP_SCHEMA_JSON_BYTES}`;
  }
  return undefined;
}

function addSerializedString(value: string, acc: SchemaBudgetAccumulator): string | undefined {
  const remaining = MAX_MCP_SCHEMA_JSON_BYTES - acc.serializedBytes;
  // UTF-8 uses at least one byte per UTF-16 code unit. Reject giant strings
  // before Buffer.byteLength or JSON escaping has to scan the whole value.
  if (value.length > remaining) {
    return `MCP JSON schema serialized size exceeds ${MAX_MCP_SCHEMA_JSON_BYTES}`;
  }
  return addSerializedBytes(Buffer.byteLength(JSON.stringify(value)), acc);
}

function hasUnsafeToJsonHook(value: object): boolean {
  let owner: object | null = value;
  while (owner) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, "toJSON");
    if (descriptor) {
      // JSON.stringify performs an inherited Get before testing callability.
      // Inspect descriptors only: an accessor must never run during preflight.
      return !("value" in descriptor) || typeof descriptor.value === "function";
    }
    owner = Object.getPrototypeOf(owner);
  }
  return false;
}

function walkSchema(
  node: unknown,
  depth: number,
  acc: SchemaBudgetAccumulator
): string | undefined {
  if (depth > MAX_MCP_SCHEMA_DEPTH) {
    return `MCP JSON schema nesting depth exceeds ${MAX_MCP_SCHEMA_DEPTH}`;
  }

  acc.nodes += 1;
  if (acc.nodes > MAX_MCP_SCHEMA_NODES) {
    return `MCP JSON schema node count exceeds ${MAX_MCP_SCHEMA_NODES}`;
  }

  if (typeof node === "string") {
    return addSerializedString(node, acc);
  }
  if (node === null) {
    return addSerializedBytes(4, acc);
  }
  if (typeof node === "boolean") {
    return addSerializedBytes(node ? 4 : 5, acc);
  }
  if (typeof node === "number") {
    if (!Number.isFinite(node)) return "MCP JSON schema contains a non-JSON number";
    return addSerializedBytes(Buffer.byteLength(JSON.stringify(node)), acc);
  }
  if (typeof node !== "object") {
    return "MCP JSON schema contains a non-JSON value";
  }

  if (acc.seen.has(node)) {
    return "MCP JSON schema is not JSON-serializable";
  }
  acc.seen.add(node);

  if (Array.isArray(node)) {
    if (Object.getPrototypeOf(node) !== Array.prototype) {
      return "MCP JSON schema is not plain JSON data";
    }
    if (node.length > MAX_MCP_SCHEMA_NODES - acc.nodes) {
      return `MCP JSON schema node count exceeds ${MAX_MCP_SCHEMA_NODES}`;
    }
    if (hasUnsafeToJsonHook(node)) {
      return "MCP JSON schema contains a custom toJSON function";
    }
    let error = addSerializedBytes(2 + Math.max(0, node.length - 1), acc);
    if (error) return error;
    for (let index = 0; index < node.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(node, String(index));
      if (!descriptor) {
        error = addSerializedBytes(4, acc);
      } else if (!("value" in descriptor)) {
        return "MCP JSON schema contains an accessor";
      } else {
        error = walkSchema(descriptor.value, depth + 1, acc);
      }
      if (error) return error;
    }
  } else {
    const prototype = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) {
      return "MCP JSON schema is not plain JSON data";
    }
    if (hasUnsafeToJsonHook(node)) {
      return "MCP JSON schema contains a custom toJSON function";
    }
    const asyncFlag = Object.getOwnPropertyDescriptor(node, "$async");
    if (asyncFlag && "value" in asyncFlag && asyncFlag.value === true) {
      return "MCP JSON schema uses unsupported asynchronous validation";
    }
    let error = addSerializedBytes(2, acc);
    if (error) return error;
    let entries = 0;
    for (const key in node as Record<string, unknown>) {
      if (!Object.hasOwn(node, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor?.enumerable) continue;
      if (!("value" in descriptor)) return "MCP JSON schema contains an accessor";
      if (entries > 0) {
        error = addSerializedBytes(1, acc);
        if (error) return error;
      }
      entries += 1;
      error = addSerializedString(key, acc);
      if (error) return error;
      error = addSerializedBytes(1, acc);
      if (error) return error;
      error = walkSchema(descriptor.value, depth + 1, acc);
      if (error) return error;
    }
  }
  acc.seen.delete(node);
  return undefined;
}

export function getMcpJsonSchemaBudgetError(schema: unknown): string | undefined {
  try {
    // Measure JSON tokens during the bounded descriptor walk. This keeps deep,
    // cyclic, broad, sparse, giant-string, and accessor-backed graphs from
    // making a later whole-schema JSON.stringify the unbounded operation.
    const walkError = walkSchema(schema, 0, {
      nodes: 0,
      serializedBytes: 0,
      seen: new WeakSet(),
    });
    if (walkError) return walkError;
  } catch {
    // error-policy:J3 hostile accessors/proxies are not valid JSON Schema.
    return "MCP JSON schema is not safely traversable";
  }

  return undefined;
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
