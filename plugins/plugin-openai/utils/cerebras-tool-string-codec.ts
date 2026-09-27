/** Reversible transport for the observed Cerebras Qwen native string-boundary loss. */
import {
  assertSchemaAnnotationsSerializable,
  ElizaError,
  MAX_WELL_FORMED_DEPTH,
} from "@elizaos/core";
import { asSchema, type JSONSchema7, jsonSchema, type ModelMessage, type ToolSet } from "ai";

import { cloneSchemaForBoundedTransport } from "./schema-compat";

const guidance =
  "String argument values must be JSON string literals with enclosing quotes; object property names stay unchanged.";

function invalid(path: string, reason: string): never {
  throw new ElizaError(`Native tool string transport rejected ${reason}.`, {
    code: "CEREBRAS_TOOL_STRING_CODEC_INVALID",
    severity: "ephemeral",
    context: { path },
  });
}

/** JSON values only; never infer missing quotes, whitespace, or escapes. */
export function mapToolStrings(
  value: unknown,
  direction: "encode" | "decode",
  path = "$",
  depth = 0
): unknown {
  if (depth > MAX_WELL_FORMED_DEPTH) invalid(path, "excessive depth");
  if (typeof value === "string") {
    if (direction === "encode") return JSON.stringify(value);
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch {
      invalid(path, "a malformed JSON string literal");
    }
    if (typeof decoded !== "string") invalid(path, "a non-string JSON literal");
    return decoded;
  }
  if (typeof value === "number" && !Number.isFinite(value)) invalid(path, "a non-finite number");
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value))
    return value.map((item, index) =>
      mapToolStrings(item, direction, `${path}[${index}]`, depth + 1)
    );
  if (!value || typeof value !== "object") invalid(path, "a non-JSON value");
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    invalid(path, "a non-JSON object");
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) invalid(path, "an accessor value");
    Object.defineProperty(result, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: mapToolStrings(descriptor.value, direction, `${path}.${key}`, depth + 1),
    });
  }
  return result;
}

const schemaMaps = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
];
const schemaSingles = [
  "additionalProperties",
  "additionalItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
];
const schemaArrays = ["anyOf", "oneOf", "allOf", "prefixItems"];

/** Keeps full source constraints visible; validation still uses the original schema. */
export function encodeToolStringSchema(schema: JSONSchema7, depth = 0): JSONSchema7 {
  if (depth > MAX_WELL_FORMED_DEPTH) invalid("schema", "excessive depth");
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const next = { ...schema } as Record<string, unknown>;
  for (const key of ["const", "enum", "default", "examples"]) {
    if (Object.hasOwn(next, key)) next[key] = mapToolStrings(next[key], "encode");
  }
  {
    const constraints: Record<string, unknown> = {};
    for (const key of [
      "minLength",
      "maxLength",
      "pattern",
      "format",
      "contentEncoding",
      "contentMediaType",
    ]) {
      if (Object.hasOwn(next, key)) {
        constraints[key] = next[key];
        delete next[key];
      }
    }
    if (Object.keys(constraints).length)
      next.description = [
        schema.description,
        `Original decoded-string constraints: ${JSON.stringify(constraints)}.`,
      ]
        .filter(Boolean)
        .join("\n");
  }
  for (const key of schemaMaps) {
    const entries = next[key];
    if (entries && typeof entries === "object" && !Array.isArray(entries))
      next[key] = Object.fromEntries(
        Object.entries(entries).map(([name, child]) => [
          name,
          encodeToolStringSchema(child as JSONSchema7, depth + 1),
        ])
      );
  }
  for (const key of schemaSingles) {
    // Object keys are not string argument values and must not be encoded.
    if (key === "propertyNames") continue;
    if (next[key] && typeof next[key] === "object")
      next[key] = encodeToolStringSchema(next[key] as JSONSchema7, depth + 1);
  }
  for (const key of schemaArrays)
    if (Array.isArray(next[key]))
      next[key] = (next[key] as JSONSchema7[]).map((child) =>
        encodeToolStringSchema(child, depth + 1)
      );
  if (next.items)
    next.items = Array.isArray(next.items)
      ? next.items.map((child) => encodeToolStringSchema(child, depth + 1))
      : encodeToolStringSchema(next.items as JSONSchema7, depth + 1);
  return next as JSONSchema7;
}

export function usesCerebrasToolStringCodec(endpoint: string | undefined, model: string): boolean {
  if (model !== "qwen-3.8-27b") return false;
  try {
    const url = new URL(endpoint ?? "");
    return url.protocol === "https:" && url.hostname === "api.cerebras.ai" && !url.port;
  } catch {
    return false;
  }
}

export async function prepareCerebrasToolStringCodec(
  tools: ToolSet | undefined,
  enabled: boolean,
  signal?: AbortSignal
) {
  const checkAbort = (options: object) => {
    signal?.throwIfAborted();
    // The SDK approval callback omits abortSignal; use the owning request too.
    if ("abortSignal" in options && options.abortSignal instanceof AbortSignal)
      options.abortSignal.throwIfAborted();
  };
  const names = new Set<string>();
  let encodedTools = tools;
  if (enabled && tools) {
    encodedTools = Object.create(Object.getPrototypeOf(tools)) as ToolSet;
    for (const [name, tool] of Object.entries(tools)) {
      const original = asSchema(tool.inputSchema);
      const originalJsonSchema = cloneSchemaForBoundedTransport(
        await original.jsonSchema
      ) as JSONSchema7;
      assertSchemaAnnotationsSerializable(originalJsonSchema);
      if ((tool.execute || typeof tool.needsApproval === "function") && !original.validate)
        invalid(name, "an executable tool without original-schema validation");
      const validatedInputs = new WeakMap<object, { wire: string; decoded: unknown }>();
      const encodeValidated = (decoded: unknown): unknown => {
        const encoded = mapToolStrings(decoded, "encode");
        if (encoded && typeof encoded === "object")
          validatedInputs.set(encoded, { wire: JSON.stringify(encoded), decoded });
        return encoded;
      };
      const decodeForHook = async (input: unknown): Promise<unknown> => {
        const prior = input && typeof input === "object" ? validatedInputs.get(input) : undefined;
        if (prior && prior.wire === JSON.stringify(input))
          return mapToolStrings(mapToolStrings(prior.decoded, "encode"), "decode");
        const decoded = mapToolStrings(input, "decode");
        if (!original.validate) invalid(name, "an effect hook without original-schema validation");
        const result = await original.validate(decoded);
        if (!result.success) throw result.error;
        return result.value;
      };
      const descriptors = Object.getOwnPropertyDescriptors(tool);
      descriptors.inputSchema = {
        configurable: true,
        enumerable: true,
        writable: true,
        value: jsonSchema(encodeToolStringSchema(originalJsonSchema), {
          validate: async (value) => {
            try {
              const decoded = mapToolStrings(value, "decode");
              if (original.validate) {
                const result = await original.validate(decoded);
                if (!result.success) return result;
                return { success: true, value: encodeValidated(result.value) };
              }
              // Plain JSON-schema native actions are validated by core against
              // their canonical Action schema after restoration. This transport
              // validator proves encoding only, not arbitrary schema compliance.
              return { success: true, value };
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error : new Error(String(error)),
              };
            }
          },
        }),
      };
      descriptors.description = {
        configurable: true,
        enumerable: true,
        writable: true,
        value: [tool.description, guidance].filter(Boolean).join("\n"),
      };
      if (typeof tool.needsApproval === "function") {
        const needsApproval = tool.needsApproval;
        descriptors.needsApproval = {
          configurable: true,
          enumerable: true,
          writable: true,
          value: async (input: unknown, options: Parameters<typeof needsApproval>[1]) => {
            checkAbort(options);
            const decoded = await decodeForHook(input);
            checkAbort(options);
            return needsApproval(decoded, options);
          },
        };
      }
      if (tool.onInputStart || tool.onInputDelta || tool.onInputAvailable) {
        if (!original.validate) invalid(name, "an input hook without original-schema validation");
        // SDK deltas contain transport strings. Publish only a complete validated
        // canonical argument object, retaining call metadata and cancellation.
        const starts = new Map<string, Parameters<NonNullable<typeof tool.onInputStart>>[0]>();
        const deltas = new Map<string, Parameters<NonNullable<typeof tool.onInputDelta>>[0]>();
        const hookDescriptor = <T>(value: T) => ({
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
        descriptors.onInputStart = hookDescriptor(
          (options: Parameters<NonNullable<typeof tool.onInputStart>>[0]) => {
            starts.set(options.toolCallId, options);
          }
        );
        descriptors.onInputDelta = hookDescriptor(
          (options: Parameters<NonNullable<typeof tool.onInputDelta>>[0]) => {
            deltas.set(options.toolCallId, options);
          }
        );
        descriptors.onInputAvailable = hookDescriptor(
          async (options: Parameters<NonNullable<typeof tool.onInputAvailable>>[0]) => {
            const start = starts.get(options.toolCallId);
            const delta = deltas.get(options.toolCallId);
            starts.delete(options.toolCallId);
            deltas.delete(options.toolCallId);
            checkAbort(options);
            const input = await decodeForHook(options.input);
            checkAbort(options);
            if (tool.onInputStart) await tool.onInputStart(start ?? options);
            checkAbort(options);
            if (tool.onInputDelta)
              await tool.onInputDelta({
                ...(delta ?? options),
                inputTextDelta: JSON.stringify(input),
              });
            checkAbort(options);
            if (tool.onInputAvailable) await tool.onInputAvailable({ ...options, input });
          }
        );
      }
      if (tool.execute) {
        const execute = tool.execute;
        descriptors.execute = {
          configurable: true,
          enumerable: true,
          writable: true,
          value: async (input: unknown, options: Parameters<typeof execute>[1]) => {
            checkAbort(options);
            const decoded = await decodeForHook(input);
            checkAbort(options);
            return execute(decoded, options);
          },
        };
      }
      Object.defineProperty(encodedTools, name, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: Object.create(Object.getPrototypeOf(tool), descriptors),
      });
      names.add(name);
    }
  }
  return {
    tools: encodedTools,
    enabled: names.size > 0,
    hasEffectHooks:
      !!tools &&
      Object.values(tools).some((tool) =>
        [
          tool.execute,
          tool.needsApproval,
          tool.onInputStart,
          tool.onInputDelta,
          tool.onInputAvailable,
        ].some((hook) => typeof hook === "function")
      ),
    encodeMessages(messages: ModelMessage[] | undefined): ModelMessage[] | undefined {
      if (!names.size || !messages) return messages;
      return messages.map((message) =>
        message.role === "assistant" && Array.isArray(message.content)
          ? {
              ...message,
              content: message.content.map((part) =>
                part.type === "tool-call" && names.has(part.toolName)
                  ? { ...part, input: mapToolStrings(part.input, "encode") }
                  : part
              ),
            }
          : message
      );
    },
    decodeCalls(calls: unknown): unknown {
      if (!names.size || calls === undefined) return calls;
      if (!Array.isArray(calls)) invalid("toolCalls", "a non-array tool list");
      return calls.map((call) => {
        if (!call || typeof call !== "object" || Array.isArray(call))
          invalid("toolCalls", "a non-object tool call");
        const name = call.toolName ?? call.name ?? call.function?.name;
        if (!names.has(name)) return call;
        const field = Object.hasOwn(call, "input")
          ? "input"
          : Object.hasOwn(call, "args")
            ? "args"
            : "arguments";
        if (call.invalid) return call;
        const raw = call[field] ?? call.function?.arguments;
        let input = raw;
        if (typeof raw === "string") {
          try {
            input = JSON.parse(raw);
          } catch {
            invalid(name, "malformed outer arguments");
          }
        }
        const decoded = mapToolStrings(input, "decode");
        return call.function && !Object.hasOwn(call, field)
          ? { ...call, function: { ...call.function, arguments: decoded } }
          : { ...call, [field]: decoded };
      });
    },
  };
}
