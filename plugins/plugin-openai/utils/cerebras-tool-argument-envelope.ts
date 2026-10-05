/** Native object envelope preserves string boundaries on the observed Cerebras Qwen endpoint. */
import {
  assertSchemaAnnotationsSerializable,
  ElizaError,
  MAX_WELL_FORMED_DEPTH,
} from "@elizaos/core";
import { asSchema, type JSONSchema7, jsonSchema, type ModelMessage, type ToolSet } from "ai";
import {
  cloneSchemaForBoundedTransport,
  JSON_SCHEMA_ARRAY_KEYWORDS,
  JSON_SCHEMA_MAP_KEYWORDS,
  JSON_SCHEMA_MIXED_MAP_KEYWORDS,
  JSON_SCHEMA_SINGLE_KEYWORDS,
} from "./schema-compat";

function invalid(path: string, reason: string): never {
  throw new ElizaError(`Native tool argument envelope rejected ${reason}.`, {
    code: "CEREBRAS_TOOL_ARGUMENT_ENVELOPE_INVALID",
    severity: "ephemeral",
    context: { path },
  });
}

/** Copy JSON values without invoking accessors or silently erasing transformed values. */
function cloneJsonValue(value: unknown, path = "$", depth = 0): unknown {
  if (depth > MAX_WELL_FORMED_DEPTH) invalid(path, "excessive depth");
  if (typeof value === "number" && !Number.isFinite(value)) invalid(path, "a non-finite number");
  if (value === null || ["string", "boolean", "number"].includes(typeof value)) return value;
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value as object);
    const length = descriptors.length.value as number;
    if (Reflect.ownKeys(descriptors).length !== length + 1)
      invalid(path, "a sparse or non-JSON array");
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor) invalid(path, "a sparse array");
      if (!("value" in descriptor)) invalid(path, "an accessor array element");
      result.push(cloneJsonValue(descriptor.value, `${path}[${index}]`, depth + 1));
    }
    return result;
  }
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
      value: cloneJsonValue(descriptor.value, `${path}.${key}`, depth + 1),
    });
  }
  return result;
}

function cloneArgumentObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("arguments", "non-object arguments");
  return cloneJsonValue(value) as Record<string, unknown>;
}

export function encodeToolArguments(value: unknown): { arguments: Record<string, unknown> } {
  return { arguments: cloneArgumentObject(value) };
}

export function decodeToolArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("envelope", "a non-object envelope");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== 1 || !Object.hasOwn(descriptors, "arguments"))
    invalid("envelope", "missing or extra envelope fields");
  const descriptor = descriptors.arguments;
  if (!("value" in descriptor)) invalid("arguments", "an accessor value");
  return cloneArgumentObject(descriptor.value);
}

/** Rebase local document pointers; unsupported resource scopes fail before dispatch. */
function rebaseLocalSchemaReferences(schema: unknown, depth = 0): void {
  if (depth > MAX_WELL_FORMED_DEPTH) invalid("schema", "excessive depth");
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const node = schema as Record<string, unknown>;
  if (
    ["$id", "$anchor", "$dynamicAnchor", "$dynamicRef", "$recursiveRef"].some((key) =>
      Object.hasOwn(node, key)
    )
  )
    invalid("schema", "unsupported reference resource scopes");
  if (Object.hasOwn(node, "$ref")) {
    const ref = node.$ref;
    if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/")))
      invalid("schema", "unsupported external or anchor reference");
    node.$ref = `#/properties/arguments${ref.slice(1)}`;
  }
  for (const key of [...JSON_SCHEMA_MAP_KEYWORDS, ...JSON_SCHEMA_MIXED_MAP_KEYWORDS]) {
    const map = node[key];
    if (map && typeof map === "object" && !Array.isArray(map))
      for (const value of Object.values(map)) rebaseLocalSchemaReferences(value, depth + 1);
  }
  for (const key of [...JSON_SCHEMA_ARRAY_KEYWORDS, "items"]) {
    const child = node[key];
    if (Array.isArray(child))
      for (const value of child) rebaseLocalSchemaReferences(value, depth + 1);
    else rebaseLocalSchemaReferences(child, depth + 1);
  }
  for (const key of JSON_SCHEMA_SINGLE_KEYWORDS) rebaseLocalSchemaReferences(node[key], depth + 1);
}

/** The complete canonical schema stays native and unchanged inside one object property. */
export function envelopeToolSchema(schema: JSONSchema7): JSONSchema7 {
  const nested = cloneSchemaForBoundedTransport(schema) as JSONSchema7;
  rebaseLocalSchemaReferences(nested);
  return {
    type: "object",
    properties: { arguments: nested },
    required: ["arguments"],
    additionalProperties: false,
  };
}

export function usesCerebrasToolArgumentEnvelope(
  endpoint: string | undefined,
  model: string
): boolean {
  if (model !== "qwen-3.8-27b") return false;
  try {
    const url = new URL(endpoint ?? "");
    return url.protocol === "https:" && url.hostname === "api.cerebras.ai" && !url.port;
  } catch {
    return false;
  }
}

export async function prepareCerebrasToolArgumentEnvelope(
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
        const encoded = encodeToolArguments(decoded);
        if (encoded && typeof encoded === "object")
          validatedInputs.set(encoded, { wire: JSON.stringify(encoded), decoded });
        return encoded;
      };
      const decodeForHook = async (input: unknown): Promise<unknown> => {
        const prior = input && typeof input === "object" ? validatedInputs.get(input) : undefined;
        if (prior && prior.wire === JSON.stringify(input))
          return cloneArgumentObject(prior.decoded);
        const decoded = decodeToolArguments(input);
        if (!original.validate) invalid(name, "an effect hook without original-schema validation");
        const result = await original.validate(decoded);
        if (!result.success) throw result.error;
        return cloneArgumentObject(result.value);
      };
      const descriptors = Object.getOwnPropertyDescriptors(tool);
      descriptors.inputSchema = {
        configurable: true,
        enumerable: true,
        writable: true,
        value: jsonSchema(envelopeToolSchema(originalJsonSchema), {
          validate: async (value) => {
            try {
              const decoded = decodeToolArguments(value);
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
        value: tool.description,
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
        // SDK deltas contain the transport wrapper. Publish only a complete validated
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
                  ? { ...part, input: encodeToolArguments(part.input) }
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
        const decoded = decodeToolArguments(input);
        return call.function && !Object.hasOwn(call, field)
          ? { ...call, function: { ...call.function, arguments: decoded } }
          : { ...call, [field]: decoded };
      });
    },
  };
}
