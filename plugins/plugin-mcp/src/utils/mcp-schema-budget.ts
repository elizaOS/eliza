/**
 * Preflight budget for untrusted MCP tool `inputSchema` documents before Ajv
 * compiles them. Connected MCP servers supply that JSON Schema; a 75-byte
 * `allOf: [{ $ref: "#" }, { $ref: "#" }]` document makes Ajv recurse until
 * `RangeError`, and a shared Ajv cache 500s when two tools reuse the same `$id`.
 *
 * This walker is dependency-free so the bomb shape can be proven without
 * pulling Ajv or `@elizaos/core` into the unit.
 */

export const MAX_MCP_SCHEMA_JSON_BYTES = 256 * 1024;
export const MAX_MCP_SCHEMA_DEPTH = 32;
export const MAX_MCP_SCHEMA_NODES = 2048;

export class McpSchemaTooComplexError extends Error {
  readonly code = "MCP_SCHEMA_TOO_COMPLEX";

  constructor(reason: string) {
    super(`MCP JSON schema rejected: ${reason}`);
    this.name = "McpSchemaTooComplexError";
  }
}

const COMPOSITION_KEYS = ["allOf", "anyOf", "oneOf"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalRefTarget(ref: string): string {
  if (ref === "#" || ref === "#/") {
    return "#";
  }
  return ref;
}

function assertCompositionDoesNotDoubleRefSelf(
  record: Record<string, unknown>,
  keyword: (typeof COMPOSITION_KEYS)[number]
): void {
  const items = record[keyword];
  if (!Array.isArray(items)) {
    return;
  }
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!isRecord(item) || typeof item.$ref !== "string") {
      continue;
    }
    const target = canonicalRefTarget(item.$ref);
    const next = (counts.get(target) ?? 0) + 1;
    counts.set(target, next);
    if (next >= 2) {
      throw new McpSchemaTooComplexError(
        `${keyword} contains two $refs to ${target} (Ajv compile recurses until RangeError)`
      );
    }
  }
}

function walk(node: unknown, depth: number, acc: { nodes: number }): void {
  if (depth > MAX_MCP_SCHEMA_DEPTH) {
    throw new McpSchemaTooComplexError(`nesting depth exceeds ${MAX_MCP_SCHEMA_DEPTH}`);
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  acc.nodes += 1;
  if (acc.nodes > MAX_MCP_SCHEMA_NODES) {
    throw new McpSchemaTooComplexError(`node count exceeds ${MAX_MCP_SCHEMA_NODES}`);
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, depth + 1, acc);
    }
    return;
  }
  const record = node as Record<string, unknown>;
  for (const keyword of COMPOSITION_KEYS) {
    assertCompositionDoesNotDoubleRefSelf(record, keyword);
  }
  for (const value of Object.values(record)) {
    walk(value, depth + 1, acc);
  }
}

/**
 * Throw {@link McpSchemaTooComplexError} when `schema` is not a bounded JSON
 * document or contains the Ajv compile bomb (composition of two `$ref`s to
 * the same target). Callers map the typed error to an invalid-schema result.
 */
export function assertMcpJsonSchemaBudget(schema: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    throw new McpSchemaTooComplexError("schema is not JSON-serializable");
  }
  if (typeof serialized !== "string") {
    throw new McpSchemaTooComplexError("schema is not JSON-serializable");
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_MCP_SCHEMA_JSON_BYTES) {
    throw new McpSchemaTooComplexError(
      `serialized size ${bytes} exceeds ${MAX_MCP_SCHEMA_JSON_BYTES}`
    );
  }
  walk(schema, 0, { nodes: 0 });
}
