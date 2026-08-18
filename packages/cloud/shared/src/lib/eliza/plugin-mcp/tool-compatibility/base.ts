/** Transforms hosted MCP tool schemas for provider-specific compatibility. */
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";

const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_VISITS = 10_000;
const MAX_TRAVERSAL_DIAGNOSTICS = 8;
const MAX_DIAGNOSTIC_DEPTH = 8;
const MAX_DIAGNOSTIC_NODES = 256;
const MAX_DIAGNOSTIC_ENTRIES = 64;
const MAX_DIAGNOSTIC_STRING_LENGTH = 512;
const MAX_DIAGNOSTIC_JSON_LENGTH = 4_096;

interface TraversalContext {
  completed: WeakMap<object, JSONSchema7>;
  ancestors: WeakSet<object>;
  visits: number;
  diagnostics: Set<string>;
}

interface DiagnosticSerializationContext {
  ancestors: WeakSet<object>;
  nodes: number;
}

function defineEnumerable(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isArraySafely(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function cloneEnumerableDataProperties(source: object): {
  clone: Record<string, unknown>;
  omittedAccessor: boolean;
} {
  const clone = Object.create(null) as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  let omittedAccessor = false;

  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable) continue;
    if (!("value" in descriptor)) {
      omittedAccessor = true;
      continue;
    }
    defineEnumerable(clone, key, descriptor.value);
  }

  return { clone, omittedAccessor };
}

export type ModelProvider = "openai" | "anthropic" | "google" | "bitrouter" | "unknown";

export interface ModelInfo {
  provider: ModelProvider;
  modelId: string;
  supportsStructuredOutputs?: boolean;
  isReasoningModel?: boolean;
}

export abstract class McpToolCompatibility {
  protected modelInfo: ModelInfo;

  constructor(modelInfo: ModelInfo) {
    this.modelInfo = modelInfo;
  }

  abstract shouldApply(): boolean;

  transformToolSchema<TSchema extends JSONSchema7>(toolSchema: TSchema): TSchema {
    return this.shouldApply() ? (this.processSchema(toolSchema) as TSchema) : toolSchema;
  }

  protected processSchema(schema: JSONSchema7): JSONSchema7 {
    const context: TraversalContext = {
      completed: new WeakMap<object, JSONSchema7>(),
      ancestors: new WeakSet<object>(),
      visits: 0,
      diagnostics: new Set<string>(),
    };
    const processed = this.processSchemaNode(schema, context, 0);
    if (context.diagnostics.size > 0) {
      const original =
        typeof processed.description === "string" ? processed.description : undefined;
      processed.description = [original, ...context.diagnostics].filter(Boolean).join("\n");
    }
    return processed;
  }

  private processSchemaNode(
    schema: JSONSchema7,
    context: TraversalContext,
    depth: number,
  ): JSONSchema7 {
    context.visits += 1;
    if (context.visits > MAX_SCHEMA_VISITS) {
      return this.diagnosticSchema(context, "traversal node limit reached");
    }
    if (depth > MAX_SCHEMA_DEPTH) {
      return this.diagnosticSchema(context, "traversal depth limit reached");
    }
    if (context.ancestors.has(schema)) {
      return this.diagnosticSchema(context, "cyclic schema reference omitted");
    }

    const existing = context.completed.get(schema);
    if (existing) return existing;

    let sanitized: Record<string, unknown>;
    try {
      const cloned = cloneEnumerableDataProperties(schema);
      sanitized = cloned.clone;
      if (cloned.omittedAccessor) {
        this.addDiagnostic(context, "schema accessor omitted");
      }
    } catch {
      return this.diagnosticSchema(context, "uninspectable schema node omitted");
    }

    context.ancestors.add(schema);

    let processed: JSONSchema7;

    switch (sanitized.type) {
      case "string":
        processed = this.processTypeSchema(
          sanitized as JSONSchema7,
          this.getUnsupportedStringProperties(),
        );
        break;
      case "number":
      case "integer":
        processed = this.processTypeSchema(
          sanitized as JSONSchema7,
          this.getUnsupportedNumberProperties(),
        );
        break;
      case "array":
        processed = this.processArraySchema(sanitized as JSONSchema7);
        break;
      case "object":
        processed = this.processObjectSchema(sanitized as JSONSchema7);
        break;
      default:
        processed = this.processGenericSchema(sanitized as JSONSchema7);
    }

    const recordKeys = [
      "properties",
      "patternProperties",
      "definitions",
      "$defs",
      "dependentSchemas",
    ] as const;
    for (const key of recordKeys) {
      if (!Object.hasOwn(processed, key)) continue;
      const record = sanitized[key];
      if (typeof record !== "object" || record === null || isArraySafely(record)) continue;
      const next = Object.create(null) as Record<string, JSONSchema7Definition>;
      let descriptors: PropertyDescriptorMap;
      try {
        descriptors = Object.getOwnPropertyDescriptors(record);
      } catch {
        delete (processed as Record<string, unknown>)[key];
        this.addDiagnostic(context, "uninspectable schema map omitted");
        continue;
      }
      for (const name of Object.keys(descriptors)) {
        const descriptor = descriptors[name];
        if (!descriptor?.enumerable) continue;
        if (context.visits >= MAX_SCHEMA_VISITS) {
          this.addDiagnostic(context, "traversal node limit reached");
          break;
        }
        if (!("value" in descriptor)) {
          this.addDiagnostic(context, "schema accessor omitted");
          continue;
        }
        defineEnumerable(
          next,
          name,
          this.processSchemaDefinition(descriptor.value, context, depth + 1),
        );
      }
      defineEnumerable(processed, key, next);
    }

    for (const key of [
      "additionalProperties",
      "additionalItems",
      "contains",
      "propertyNames",
      "not",
      "if",
      "then",
      "else",
      "unevaluatedItems",
      "unevaluatedProperties",
      "contentSchema",
    ] as const) {
      if (!Object.hasOwn(processed, key)) continue;
      const value = sanitized[key];
      if (typeof value === "object" && value !== null && !isArraySafely(value)) {
        defineEnumerable(processed, key, this.processSchemaDefinition(value, context, depth + 1));
      }
    }

    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
      if (!Object.hasOwn(processed, key)) continue;
      const value = sanitized[key];
      if (isArraySafely(value)) {
        defineEnumerable(processed, key, this.processSchemaArray(value, context, depth + 1));
      }
    }

    if (isArraySafely(sanitized.items)) {
      defineEnumerable(
        processed,
        "items",
        this.processSchemaArray(sanitized.items, context, depth + 1),
      );
    } else if (
      typeof sanitized.items === "object" &&
      sanitized.items !== null &&
      Object.hasOwn(processed, "items")
    ) {
      defineEnumerable(
        processed,
        "items",
        this.processSchemaDefinition(sanitized.items, context, depth + 1),
      );
    }

    const dependencies = sanitized.dependencies;
    if (
      Object.hasOwn(processed, "dependencies") &&
      typeof dependencies === "object" &&
      dependencies !== null &&
      !isArraySafely(dependencies)
    ) {
      const next = Object.create(null) as Record<string, unknown>;
      try {
        const descriptors = Object.getOwnPropertyDescriptors(dependencies);
        for (const name of Object.keys(descriptors)) {
          if (context.visits >= MAX_SCHEMA_VISITS) {
            this.addDiagnostic(context, "traversal node limit reached");
            break;
          }
          const descriptor = descriptors[name];
          if (!descriptor?.enumerable) continue;
          if (!("value" in descriptor)) {
            this.addDiagnostic(context, "schema accessor omitted");
            continue;
          }
          const value = descriptor.value;
          defineEnumerable(
            next,
            name,
            typeof value === "object" && value !== null && !isArraySafely(value)
              ? this.processSchemaDefinition(value, context, depth + 1)
              : value,
          );
        }
        defineEnumerable(processed, "dependencies", next);
      } catch {
        delete (processed as Record<string, unknown>).dependencies;
        this.addDiagnostic(context, "uninspectable schema map omitted");
      }
    }

    context.ancestors.delete(schema);
    context.completed.set(schema, processed);
    return processed;
  }

  private processSchemaArray(
    values: unknown[],
    context: TraversalContext,
    depth: number,
  ): JSONSchema7Definition[] {
    const next: JSONSchema7Definition[] = [];
    let descriptors: Record<string, PropertyDescriptor>;
    try {
      descriptors = Object.getOwnPropertyDescriptors(values) as unknown as Record<
        string,
        PropertyDescriptor
      >;
    } catch {
      this.addDiagnostic(context, "uninspectable schema array omitted");
      return next;
    }

    const lengthDescriptor = descriptors.length;
    const length =
      lengthDescriptor &&
      "value" in lengthDescriptor &&
      typeof lengthDescriptor.value === "number" &&
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value >= 0
        ? lengthDescriptor.value
        : 0;
    for (let index = 0; index < length; index += 1) {
      if (context.visits >= MAX_SCHEMA_VISITS) {
        this.addDiagnostic(context, "traversal node limit reached");
        break;
      }
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) {
        this.addDiagnostic(context, "schema array accessor or hole omitted");
        continue;
      }
      next.push(this.processSchemaDefinition(descriptor.value, context, depth));
    }
    return next;
  }

  private processSchemaDefinition(
    value: unknown,
    context: TraversalContext,
    depth: number,
  ): JSONSchema7Definition {
    if (typeof value === "boolean") {
      context.visits += 1;
      if (context.visits > MAX_SCHEMA_VISITS) {
        return this.diagnosticSchema(context, "traversal node limit reached");
      }
      return value;
    }
    if (typeof value === "object" && value !== null && !isArraySafely(value)) {
      return this.processSchemaNode(value as JSONSchema7, context, depth);
    }
    this.addDiagnostic(context, "malformed schema child preserved");
    return value as JSONSchema7Definition;
  }

  private diagnosticSchema(context: TraversalContext, message: string): JSONSchema7 {
    this.addDiagnostic(context, message);
    const schema = Object.create(null) as JSONSchema7;
    defineEnumerable(schema, "description", `[schema compatibility: ${message}]`);
    return schema;
  }

  private addDiagnostic(context: TraversalContext, message: string): void {
    if (context.diagnostics.size >= MAX_TRAVERSAL_DIAGNOSTICS) return;
    context.diagnostics.add(`[schema compatibility: ${message}]`);
  }

  protected processTypeSchema(schema: JSONSchema7, unsupported: string[]): JSONSchema7 {
    const processed = cloneEnumerableDataProperties(schema).clone as JSONSchema7;
    const constraints = Object.create(null) as Record<string, unknown>;

    // Extract all constraint properties
    for (const prop of [
      "minLength",
      "maxLength",
      "pattern",
      "format",
      "enum",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minItems",
      "maxItems",
      "uniqueItems",
      "minProperties",
      "maxProperties",
    ]) {
      if (schema[prop as keyof JSONSchema7] !== undefined) {
        defineEnumerable(constraints, prop, schema[prop as keyof JSONSchema7]);
      }
    }

    // Preserve this keyword in prose only when the provider removes it from
    // the schema. Providers that support it already receive the real rule.
    if (unsupported.includes("additionalProperties") && schema.additionalProperties !== undefined) {
      defineEnumerable(constraints, "additionalProperties", schema.additionalProperties);
    }

    for (const prop of unsupported) {
      delete (processed as Record<string, unknown>)[prop];
    }

    if (Object.keys(constraints).length > 0) {
      processed.description = this.mergeDescription(
        typeof schema.description === "string" ? schema.description : undefined,
        constraints,
      );
    }

    return processed;
  }

  protected processArraySchema(schema: JSONSchema7): JSONSchema7 {
    return this.processTypeSchema(schema, this.getUnsupportedArrayProperties());
  }

  protected processObjectSchema(schema: JSONSchema7): JSONSchema7 {
    const processed = this.processTypeSchema(schema, this.getUnsupportedObjectProperties());

    return processed;
  }

  protected processGenericSchema(schema: JSONSchema7): JSONSchema7 {
    return cloneEnumerableDataProperties(schema).clone as JSONSchema7;
  }

  protected mergeDescription(
    original: string | undefined,
    constraints: Record<string, unknown>,
  ): string {
    const json = this.serializeDiagnostic(constraints);
    return original ? `${original}\n${json}` : json;
  }

  protected serializeDiagnostic(value: unknown): string {
    try {
      const context: DiagnosticSerializationContext = {
        ancestors: new WeakSet<object>(),
        nodes: 0,
      };
      const serialized = JSON.stringify(this.toDiagnosticValue(value, context, 0));
      if (serialized === undefined) return '"[undefined]"';
      if (serialized.length <= MAX_DIAGNOSTIC_JSON_LENGTH) return serialized;
      return '{"$schemaCompatibility":"diagnostic serialization exceeded 4096 characters"}';
    } catch {
      return '{"$schemaCompatibility":"diagnostic serialization failed"}';
    }
  }

  protected serializeDiagnosticList(value: unknown): string | undefined {
    try {
      if (!isArraySafely(value)) return undefined;
      const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
        string,
        PropertyDescriptor
      >;
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value <= 0 ||
        lengthDescriptor.value > MAX_DIAGNOSTIC_ENTRIES
      ) {
        return undefined;
      }
      const items: string[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) return undefined;
        items.push(this.serializeDiagnostic(descriptor.value));
      }
      const serialized = items.join(", ");
      return serialized.length <= MAX_DIAGNOSTIC_JSON_LENGTH ? serialized : undefined;
    } catch {
      return undefined;
    }
  }

  private toDiagnosticValue(
    value: unknown,
    context: DiagnosticSerializationContext,
    depth: number,
  ): unknown {
    context.nodes += 1;
    if (context.nodes > MAX_DIAGNOSTIC_NODES) return "[node limit reached]";
    if (depth > MAX_DIAGNOSTIC_DEPTH) return "[depth limit reached]";

    switch (typeof value) {
      case "string":
        return value.length <= MAX_DIAGNOSTIC_STRING_LENGTH
          ? value
          : `${value.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH)}…[truncated]`;
      case "number":
        return Number.isFinite(value) ? value : `[non-finite number: ${String(value)}]`;
      case "bigint":
        return `[bigint:${value.toString()}]`;
      case "undefined":
        return "[undefined]";
      case "function":
        return "[function]";
      case "symbol":
        return "[symbol]";
      case "boolean":
        return value;
      case "object":
        break;
      default:
        return null;
    }

    if (value === null) return null;
    if (context.ancestors.has(value)) return "[circular]";
    context.ancestors.add(value);

    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (isArraySafely(value)) {
        const lengthDescriptor = descriptors.length;
        const length =
          lengthDescriptor &&
          "value" in lengthDescriptor &&
          typeof lengthDescriptor.value === "number"
            ? Math.min(lengthDescriptor.value, MAX_DIAGNOSTIC_ENTRIES)
            : 0;
        const result: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor) {
            result.push("[empty]");
          } else if ("value" in descriptor) {
            result.push(this.toDiagnosticValue(descriptor.value, context, depth + 1));
          } else {
            result.push("[accessor omitted]");
          }
        }
        if (
          lengthDescriptor &&
          "value" in lengthDescriptor &&
          typeof lengthDescriptor.value === "number" &&
          lengthDescriptor.value > MAX_DIAGNOSTIC_ENTRIES
        ) {
          result.push(`[${lengthDescriptor.value - MAX_DIAGNOSTIC_ENTRIES} entries omitted]`);
        }
        return result;
      }

      const result = Object.create(null) as Record<string, unknown>;
      const keys = Object.keys(descriptors)
        .filter((key) => descriptors[key]?.enumerable)
        .sort();
      for (const key of keys.slice(0, MAX_DIAGNOSTIC_ENTRIES)) {
        const descriptor = descriptors[key];
        defineEnumerable(
          result,
          key,
          descriptor && "value" in descriptor
            ? this.toDiagnosticValue(descriptor.value, context, depth + 1)
            : "[accessor omitted]",
        );
      }
      if (keys.length > MAX_DIAGNOSTIC_ENTRIES) {
        let diagnosticKey = "$schemaCompatibilityOmittedEntries";
        while (Object.hasOwn(result, diagnosticKey)) diagnosticKey = `$${diagnosticKey}`;
        defineEnumerable(result, diagnosticKey, keys.length - MAX_DIAGNOSTIC_ENTRIES);
      }
      return result;
    } finally {
      context.ancestors.delete(value);
    }
  }

  protected abstract getUnsupportedStringProperties(): string[];
  protected abstract getUnsupportedNumberProperties(): string[];
  protected abstract getUnsupportedArrayProperties(): string[];
  protected abstract getUnsupportedObjectProperties(): string[];
}
