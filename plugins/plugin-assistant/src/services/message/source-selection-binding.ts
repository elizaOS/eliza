/** Request-local native history identity; selection and authorization remain runtime validated. */

import type {
  ContextObject,
  GenerateTextResult,
  JSONSchema,
} from "@elizaos/core";
import {
  ElizaError,
  parseAndValidate,
  parseCompletionContextSelection,
  completionContextSources,
  HANDLE_RESPONSE_TOOL_NAME,
} from "@elizaos/core";
import { parseToolArguments } from "./tool-arguments.ts";

import {nativeSourceOrdinalSchema} from "./native-context-read.ts";

const REQUEST_SOURCE_REFERENCE = "current_request";

/** Capture before dispatch, never from context that may change while awaiting a model. */
export function createSourceSelectionBinding(
  schema: JSONSchema,
  context: ContextObject,
  options?: {sourceOrdinals: true; assertCurrent(): void},
) {
  const completion = schema.properties?.completionContext;
  const identity = completion?.properties?.sourceSetId;
  const snapshot = completionContextSources(context);
  if (
    !completion ||
    identity?.type !== "string" ||
    snapshot.sources.length === 0
  )
    return undefined;
  const sourceSetId = snapshot.sourceSetId;
  const fields = ["relevantSourceIds", "constraintSourceIds", "referentSourceIds", "pendingIntentSourceIds"] as const;
  const ordinalMaps = new Map<string, ReadonlyMap<number, string>>();
  const numericProperties = {...completion.properties};
  if (options?.sourceOrdinals) {
    for (const name of fields) {
      const field = completion.properties?.[name], items = field?.items;
      // Only recognized builtin shapes after existing identity/subset transforms.
      // Custom extensions/constraints keep the original binding path unchanged.
      if (!field || field.type !== "array" || !items || Array.isArray(items) || items.type !== "string" ||
          Object.keys(field).some(key => !["type", "items", "description", "enum"].includes(key)) ||
          Object.keys(items).some(key => !["type", "enum", "description"].includes(key)) || !Array.isArray(items.enum) ||
          (field.enum !== undefined && !(Array.isArray(field.enum) && field.enum.length === 1 && Array.isArray(field.enum[0]) && field.enum[0].length === 0))) {
        ordinalMaps.clear(); break;
      }
      const allowed = new Set(items.enum);
      if (snapshot.sources.some((source,index) => source.id !== `h${index+1}`) ||
          [...allowed].some(id => typeof id !== "string" || !snapshot.sources.some(source => source.id === id))) {
        ordinalMaps.clear(); break;
      }
      const emptyOnly = field.enum !== undefined;
      const map = new Map(snapshot.sources.flatMap((source,index) => !emptyOnly && allowed.has(source.id) ? [[index+1,source.id] as const] : []));
      ordinalMaps.set(name,map);
      numericProperties[name] = map.size
        ? {...field,items:nativeSourceOrdinalSchema(map)}
        : {...field,enum:[[]],items:{type:"integer",minimum:1,maximum:1}};
    }
  }
  const numeric = ordinalMaps.size === fields.length;
  const parameters: JSONSchema = {
    ...schema,
    properties: {
      ...schema.properties,
      completionContext: {
        ...completion,
        properties: {
          ...(numeric ? numericProperties : completion.properties),
          sourceSetId: {
            type: "string",
            enum: [REQUEST_SOURCE_REFERENCE],
            description:
              "Use current_request. The runtime binds this reference to the exact sources supplied with this model request.",
          },
        },
      },
    },
  };
  return {
    parameters,
    resolve(raw: string | GenerateTextResult): string | GenerateTextResult {
      // Legacy JSON never gets an implicit binding. Nor do actual mismatched hashes.
      if (typeof raw === "string" || !Array.isArray(raw.toolCalls)) return raw;
      return {
        ...raw,
        toolCalls: raw.toolCalls.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return entry;
          const name = String(entry.name ?? "").trim();
          if (name !== HANDLE_RESPONSE_TOOL_NAME) return entry;
          const args = parseToolArguments(entry.arguments);
          const selection = args?.completionContext;
          if (!selection || typeof selection !== "object" || Array.isArray(selection)) return entry;
          if ((selection as Record<string, unknown>).sourceSetId !== REQUEST_SOURCE_REFERENCE) {
            if (numeric && fields.some(field => {
              const values=(selection as Record<string,unknown>)[field];
              return Array.isArray(values) && values.some(value => typeof value !== "string");
            })) {
              throw new ElizaError("Completion ordinals require this request's offered identity.", {code:"COMPLETION_CONTEXT_INVALID_ORDINAL"});
            }
            // Deliberate legacy canonical-string input, not an ordinal alias.
            return entry;
          }
          let resolvedSelection = {...selection, sourceSetId};
          if (numeric) {
            options!.assertCurrent();
            if (completionContextSources(context).sourceSetId !== sourceSetId) {
              throw new ElizaError("The completion source identity changed.", {code:"COMPLETION_CONTEXT_INVALID_ORDINAL"});
            }
            const value = selection as Record<string, unknown>;
            // Public JSONSchema is wider than the validator's legacy declared
            // union. This builtin-only constructor emits supported concrete
            // primitive/array/object/anyOf schemas; retain actual runtime validation.
            const validatorSchema = parameters.properties!.completionContext! as Parameters<typeof parseAndValidate>[1];
            if (!parseAndValidate(JSON.stringify(value), validatorSchema).valid) {
              throw new ElizaError("Use the complete offered completion ordinal contract.", {code:"COMPLETION_CONTEXT_INVALID_ORDINAL"});
            }
            if (Object.keys(value).some(key => !["mode", "sourceSetId", "complete", ...fields].includes(key))) {
              throw new ElizaError("Use only the offered completion selection fields.", {code:"COMPLETION_CONTEXT_INVALID_ORDINAL"});
            }
            const decoded: Record<string, string[]> = {};
            for (const field of fields) {
              const values = value[field], map = ordinalMaps.get(field)!;
              if (!Array.isArray(values) || new Set(values).size !== values.length || values.some(ordinal => typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || !map.has(ordinal))) {
                throw new ElizaError("Choose only offered completion source ordinals.", {code:"COMPLETION_CONTEXT_INVALID_ORDINAL"});
              }
              decoded[field] = values.map(ordinal => map.get(ordinal)!);
            }
            resolvedSelection = {...selection, ...decoded, sourceSetId};
            if (!parseCompletionContextSelection(resolvedSelection)) {
              throw new ElizaError("Use a valid canonical completion selection.", {code:"COMPLETION_CONTEXT_INVALID_ORDINAL"});
            }
          }
          return {
            ...entry,
            arguments: {
              ...args,
              completionContext: resolvedSelection,
            },
          };
        }),
      };
    },
  };
}
