/** Native read encoding only. Admission and data reads stay with the existing pipeline. */
import { ElizaError, type JSONSchema, type ToolDefinition } from "@elizaos/core";

export interface NativeHistoryReadBinding {
  sourceSetId: string;
  sources: ReadonlyMap<number, string>;
  all?: string;
  assertCurrent(): void;
  search(scope: "all" | "user" | "assistant", query: string): string;
}
export interface NativeContextReadContract {
  providers: ReadonlySet<string>;
  history?: NativeHistoryReadBinding;
}

/** Only the unconstrained builtin string-list contract can change encoding.
 * Custom constraints retain their existing constructor and validation path. */
export function supportsNativeContextReads(schema: JSONSchema | undefined): boolean {
  if (!schema || schema.type !== "array" ||
      Object.keys(schema).some(key => !["type", "items", "description"].includes(key))) return false;
  const items = schema.items;
  return !!items && !Array.isArray(items) && items.type === "string" &&
    Object.keys(items).every(key => key === "type" || key === "description");
}

const objectSchema = (properties: Record<string, JSONSchema>): JSONSchema => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
const kind = (value: string): JSONSchema => ({type: "string", enum: [value]});

/** Exact intervals retain holes without enumerating every hN as a string enum. */
export function nativeSourceOrdinalSchema(sources: ReadonlyMap<number, string>): JSONSchema {
  const values = [...sources.keys()].sort((a, b) => a - b);
  const ranges: Array<{first: number; last: number}> = [];
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 1) unsupported();
    const tail = ranges.at(-1);
    if (tail && tail.last + 1 === value) tail.last = value;
    else ranges.push({first: value, last: value});
  }
  // Equal numeric bounds also express singletons to the existing host schema
  // validator, which does not implement const. Never bridge an offered hole.
  return {type: "integer", anyOf: ranges.map(({first, last}) =>
    ({type: "integer", minimum: first, maximum: last}))};
}

export function nativeContextReadsSchema(contract: NativeContextReadContract): JSONSchema | undefined {
  const choices: JSONSchema[] = [];
  if (contract.providers.size) choices.push(objectSchema({
    kind: kind("provider"),
    references: {type: "array", items: {type: "string", enum: [...contract.providers]}},
  }));
  const history = contract.history;
  if (history) {
    const sourceSetId: JSONSchema = {type: "string", const: history.sourceSetId};
    if (history.sources.size) choices.push(objectSchema({
      kind: kind("history-source"), sourceSetId,
      sourceOrdinals: {type: "array", items: nativeSourceOrdinalSchema(history.sources)},
    }));
    choices.push(objectSchema({
      kind: kind("history-search"), sourceSetId,
      speaker: {type: "string", enum: ["all", "user", "assistant"]},
      query: {type: "string"},
    }));
    if (history.all) choices.push(objectSchema({kind: kind("history-all"), sourceSetId}));
  }
  return choices.length ? {type: "array", items: {anyOf: choices}} : undefined;
}

function invalid(): never {
  throw new ElizaError("Choose an offered context read with its current source identity.", {
    code: "CONTEXT_DISCOVERY_INVALID_READ",
  });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) invalid();
}

/** No body access, effects or acknowledgment occurs here. All values still pass readContextRequests. */
export function decodeNativeContextReads(value: unknown, contract: NativeContextReadContract): string[] {
  if (!Array.isArray(value) || !value.length) invalid();
  const result: string[] = [];
  for (const read of value) {
    if (!record(read)) invalid();
    if (read.kind === "provider") {
      exact(read, ["kind", "references"]);
      if (!Array.isArray(read.references) || !read.references.length || read.references.some(name => typeof name !== "string" || !contract.providers.has(name))) invalid();
      result.push(...read.references as string[]);
      continue;
    }
    const history = contract.history;
    if (!history || read.sourceSetId !== history.sourceSetId) invalid();
    history.assertCurrent();
    if (read.kind === "history-source") {
      exact(read, ["kind", "sourceSetId", "sourceOrdinals"]);
      if (!Array.isArray(read.sourceOrdinals) || !read.sourceOrdinals.length) invalid();
      for (const ordinal of read.sourceOrdinals) {
        if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || !history.sources.has(ordinal)) invalid();
        result.push(history.sources.get(ordinal)!);
      }
    } else if (read.kind === "history-search") {
      exact(read, ["kind", "sourceSetId", "speaker", "query"]);
      if ((read.speaker !== "all" && read.speaker !== "user" && read.speaker !== "assistant") || typeof read.query !== "string" || !read.query.trim()) invalid();
      result.push(history.search(read.speaker, read.query));
    } else if (read.kind === "history-all") {
      exact(read, ["kind", "sourceSetId"]);
      if (!history.all) invalid();
      result.push(history.all);
    } else invalid();
  }
  return [...new Set(result)];
}

function unsupported(): never {
  throw new ElizaError("The complete native context-read schema exceeds its supported contract.", {
    code: "CONTEXT_DISCOVERY_SCHEMA_UNSUPPORTED",
  });
}

/** Portable v1 strict-tool bounds verified against the served Cerebras contract.
 * These reject unsupported encodings; they never cap source data, tokens or reads. */
export function assertNativeContextReadToolBudget(tools: readonly ToolDefinition[]): void {
  let enums = 0, chars = 0, properties = 0;
  const active = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (!record(value) || depth > 10 || active.has(value)) unsupported();
    active.add(value);
    if (Array.isArray(value.enum)) {
      enums += value.enum.length;
      for (const item of value.enum) if (typeof item === "string") chars += item.length;
    }
    if (typeof value.const === "string") chars += value.const.length;
    for (const key of ["properties", "$defs", "definitions"]) {
      const entries = value[key];
      if (!record(entries)) continue;
      for (const [name, child] of Object.entries(entries)) {
        chars += name.length;
        if (key === "properties") properties++;
        visit(child, depth + 1);
      }
    }
    if (record(value.items)) visit(value.items, depth + 1);
    for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(value[key])) {
      for (const child of value[key]) visit(child, depth + 1);
    }
    active.delete(value);
    if (enums > 500 || chars > 5000 || properties > 500) unsupported();
  };
  for (const tool of tools) if (tool.parameters) visit(tool.parameters, 1);
}
