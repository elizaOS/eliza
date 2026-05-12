/**
 * Plugin config catalog & registry — reverse-engineered from vercel-labs/json-render.
 *
 * json-render pattern:
 *   defineCatalog(schema, { components, actions, functions })  →  type-safe catalog
 *   defineRegistry(catalog, { components, actions })           →  maps catalog → renderers/handlers
 *   <Renderer spec={} registry={} />                           →  traverses spec, renders
 *
 * Our adaptation for plugin config forms:
 *   defineCatalog({ fields, actions?, functions? })   →  field + action + validation catalog
 *   defineRegistry(catalog, renderers, actionHandlers?) →  maps types → render/handler functions
 *   <ConfigRenderer>                                   →  reads JSON Schema + uiHints, renders form
 *
 * New in Phase 2 (json-render feature parity):
 *   - Actions: catalog actions with Zod params + registry handlers
 *   - Rich visibility: LogicExpression (and/or/not/eq/neq/gt/gte/lt/lte)
 *   - Validation checks: declarative checks (required/email/minLength/pattern/...)
 *   - Data binding: DynamicValue with path resolution (getByPath/setByPath)
 *   - Prompt generation: catalog.prompt() for AI system prompts
 *
 * @module config-catalog
 */

import type { ReactNode } from "react";
import z from "zod";
import type {
  ConfigUiHint,
  DynamicValue,
  LogicExpression,
  ValidationCheck,
  ValidationConfig,
  VisibilityCondition,
} from "../types/index.js";

// ── JSON Schema types (subset we consume) ──────────────────────────────

export interface JsonSchemaProperty {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  description?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  properties?: Record<string, JsonSchemaProperty>;
  items?: JsonSchemaProperty;
  required?: string[];
  oneOf?: JsonSchemaProperty[];
  anyOf?: JsonSchemaProperty[];
  additionalProperties?: boolean | JsonSchemaProperty;
}

export interface JsonSchemaObject extends JsonSchemaProperty {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
}

// ── Dynamic value resolution (≈ json-render DynamicValue + getByPath) ───

/**
 * Get a value from a nested object by slash-delimited path (JSON Pointer).
 *
 * @example
 * getByPath({ a: { b: 42 } }, "a/b") // → 42
 * getByPath({ items: [1, 2] }, "items/0") // → 1
 */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path || path === "/") return obj;
  const segments = (path.startsWith("/") ? path.slice(1) : path).split("/");
  let current: unknown = obj;
  for (const seg of segments) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      current = current[parseInt(seg, 10)];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Set a value in a nested object by slash-delimited path.
 */
export function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = (path.startsWith("/") ? path.slice(1) : path).split("/");
  if (segments.length === 0) return;
  const isUnsafeKey = (k: string): boolean =>
    k === "__proto__" || k === "constructor" || k === "prototype";
  for (const seg of segments) {
    if (isUnsafeKey(seg)) return; // silently reject dangerous paths
  }
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (isUnsafeKey(seg)) return;
    if (!(seg in current) || typeof current[seg] !== "object") {
      current[seg] = /^\d+$/.test(segments[i + 1]) ? [] : {};
    }
    current = current[seg] as Record<string, unknown>;
  }
  const finalKey = segments[segments.length - 1];
  if (isUnsafeKey(finalKey)) return;
  current[finalKey] = value;
}

/**
 * Resolve a DynamicValue — if it's a {path} reference, look up in state.
 */
export function resolveDynamic<T>(
  value: DynamicValue<T>,
  state: Record<string, unknown>,
): T | undefined {
  if (value != null && typeof value === "object" && "path" in value) {
    return getByPath(state, (value as { path: string }).path) as T | undefined;
  }
  return value as T;
}

/**
 * Search for a field value by name — ported from json-render's dashboard example.
 *
 * Resolution order:
 * 1. Direct params lookup
 * 2. Params with path format (JSON Pointer)
 * 3. State walk through common form prefixes (form, newItem, create, edit, root)
 */
export function findFormValue(
  fieldName: string,
  params?: Record<string, unknown>,
  state?: Record<string, unknown>,
): unknown {
  // 1. Check direct params
  if (params && fieldName in params) return params[fieldName];

  // 2. Check params with path format
  if (params) {
    const pathValue = getByPath(params, `/${fieldName}`);
    if (pathValue !== undefined) return pathValue;
  }

  // 3. Search state - check common form prefixes
  if (state) {
    const prefixes = ["form", "newItem", "create", "edit", ""];
    for (const prefix of prefixes) {
      const path = prefix ? `/${prefix}/${fieldName}` : `/${fieldName}`;
      const val = getByPath(state, path);
      if (val !== undefined) return val;
    }
  }

  return undefined;
}

/**
 * Interpolate `{{path}}` references in a template string using context values.
 *
 * Useful for action onSuccess/onError messages that reference state values.
 *
 * @example
 * interpolateString("Created {{/form/name}} successfully", { form: { name: "Foo" } })
 * // → "Created Foo successfully"
 */
export function interpolateString(
  template: string,
  context: Record<string, unknown>,
): string {
  const safeTemplate =
    template.length > 100_000 ? template.slice(0, 100_000) : template;
  return safeTemplate.replace(/\{\{([^}]{1,1024})\}\}/g, (_, path) => {
    const value = getByPath(
      context,
      path.trim().startsWith("/") ? path.trim() : `/${path.trim()}`,
    );
    return value !== undefined ? String(value) : "";
  });
}

// ── Rich visibility evaluation (≈ json-render evaluateVisibility) ───────

/**
 * Evaluate a LogicExpression against a state model.
 */
export function evaluateLogicExpression(
  expr: LogicExpression,
  state: Record<string, unknown>,
): boolean {
  if ("and" in expr)
    return (expr as { and: LogicExpression[] }).and.every((e) =>
      evaluateLogicExpression(e, state),
    );
  if ("or" in expr)
    return (expr as { or: LogicExpression[] }).or.some((e) =>
      evaluateLogicExpression(e, state),
    );
  if ("not" in expr)
    return !evaluateLogicExpression(
      (expr as { not: LogicExpression }).not,
      state,
    );
  if ("path" in expr)
    return Boolean(getByPath(state, (expr as { path: string }).path));
  if ("eq" in expr) {
    const [l, r] = (expr as { eq: [DynamicValue, DynamicValue] }).eq;
    return resolveDynamic(l, state) === resolveDynamic(r, state);
  }
  if ("neq" in expr) {
    const [l, r] = (expr as { neq: [DynamicValue, DynamicValue] }).neq;
    return resolveDynamic(l, state) !== resolveDynamic(r, state);
  }
  if ("gt" in expr) {
    const [l, r] = (
      expr as { gt: [DynamicValue<number>, DynamicValue<number>] }
    ).gt;
    const lv = resolveDynamic(l, state),
      rv = resolveDynamic(r, state);
    return typeof lv === "number" && typeof rv === "number" && lv > rv;
  }
  if ("gte" in expr) {
    const [l, r] = (
      expr as { gte: [DynamicValue<number>, DynamicValue<number>] }
    ).gte;
    const lv = resolveDynamic(l, state),
      rv = resolveDynamic(r, state);
    return typeof lv === "number" && typeof rv === "number" && lv >= rv;
  }
  if ("lt" in expr) {
    const [l, r] = (
      expr as { lt: [DynamicValue<number>, DynamicValue<number>] }
    ).lt;
    const lv = resolveDynamic(l, state),
      rv = resolveDynamic(r, state);
    return typeof lv === "number" && typeof rv === "number" && lv < rv;
  }
  if ("lte" in expr) {
    const [l, r] = (
      expr as { lte: [DynamicValue<number>, DynamicValue<number>] }
    ).lte;
    const lv = resolveDynamic(l, state),
      rv = resolveDynamic(r, state);
    return typeof lv === "number" && typeof rv === "number" && lv <= rv;
  }
  return false;
}

/**
 * Evaluate a full VisibilityCondition.
 */
export function evaluateVisibility(
  condition: VisibilityCondition | undefined,
  state: Record<string, unknown>,
): boolean {
  if (condition === undefined) return true;
  if (typeof condition === "boolean") return condition;
  if ("path" in condition && !("and" in condition) && !("or" in condition)) {
    return Boolean(getByPath(state, (condition as { path: string }).path));
  }
  return evaluateLogicExpression(condition as LogicExpression, state);
}

// ── Visibility helpers (≈ json-render visibility.*) ─────────────────────

export const visibility = {
  always: true as const,
  never: false as const,
  when: (path: string): VisibilityCondition => ({ path }),
  and: (...conditions: LogicExpression[]): LogicExpression => ({
    and: conditions,
  }),
  or: (...conditions: LogicExpression[]): LogicExpression => ({
    or: conditions,
  }),
  not: (condition: LogicExpression): LogicExpression => ({ not: condition }),
  eq: (left: DynamicValue, right: DynamicValue): LogicExpression => ({
    eq: [left, right],
  }),
  neq: (left: DynamicValue, right: DynamicValue): LogicExpression => ({
    neq: [left, right],
  }),
  gt: (
    left: DynamicValue<number>,
    right: DynamicValue<number>,
  ): LogicExpression => ({ gt: [left, right] }),
  gte: (
    left: DynamicValue<number>,
    right: DynamicValue<number>,
  ): LogicExpression => ({ gte: [left, right] }),
  lt: (
    left: DynamicValue<number>,
    right: DynamicValue<number>,
  ): LogicExpression => ({ lt: [left, right] }),
  lte: (
    left: DynamicValue<number>,
    right: DynamicValue<number>,
  ): LogicExpression => ({ lte: [left, right] }),
};

// ── Built-in validation functions (≈ json-render builtInValidationFunctions)

export type ValidationFunction = (
  value: unknown,
  args?: Record<string, unknown>,
) => boolean;

export const builtInValidators: Record<string, ValidationFunction> = {
  required: (value) => {
    if (value == null) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  },
  email: (value) =>
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  minLength: (value, args) =>
    typeof value === "string" &&
    typeof args?.min === "number" &&
    value.length >= args.min,
  maxLength: (value, args) =>
    typeof value === "string" &&
    typeof args?.max === "number" &&
    value.length <= args.max,
  pattern: (value, args) => {
    if (typeof value !== "string" || typeof args?.pattern !== "string")
      return false;
    try {
      return new RegExp(args.pattern).test(value);
    } catch {
      return false;
    }
  },
  min: (value, args) =>
    typeof value === "number" &&
    typeof args?.min === "number" &&
    value >= args.min,
  max: (value, args) =>
    typeof value === "number" &&
    typeof args?.max === "number" &&
    value <= args.max,
  numeric: (value) =>
    typeof value === "number"
      ? !Number.isNaN(value)
      : typeof value === "string" && !Number.isNaN(parseFloat(value)),
  url: (value) => {
    if (typeof value !== "string") return false;
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  },
  matches: (value, args) => value === args?.other,
};

/**
 * Run validation checks for a field value.
 */
export function runValidation(
  config: ValidationConfig,
  value: unknown,
  state: Record<string, unknown>,
  customFunctions?: Record<string, ValidationFunction>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check if validation is enabled
  if (config.enabled && !evaluateLogicExpression(config.enabled, state)) {
    return { valid: true, errors: [] };
  }

  if (config.checks) {
    for (const check of config.checks) {
      // Resolve dynamic args
      const resolvedArgs: Record<string, unknown> = {};
      if (check.args) {
        for (const [k, v] of Object.entries(check.args)) {
          resolvedArgs[k] = resolveDynamic(v, state);
        }
      }
      const fn = builtInValidators[check.fn] ?? customFunctions?.[check.fn];
      if (fn && !fn(value, resolvedArgs)) {
        errors.push(check.message);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Validation check helpers (≈ json-render check.*) ────────────────────

export const check = {
  required: (message = "This field is required"): ValidationCheck => ({
    fn: "required",
    message,
  }),
  email: (message = "Invalid email address"): ValidationCheck => ({
    fn: "email",
    message,
  }),
  minLength: (min: number, message?: string): ValidationCheck => ({
    fn: "minLength",
    args: { min },
    message: message ?? `Must be at least ${min} characters`,
  }),
  maxLength: (max: number, message?: string): ValidationCheck => ({
    fn: "maxLength",
    args: { max },
    message: message ?? `Must be at most ${max} characters`,
  }),
  pattern: (pattern: string, message = "Invalid format"): ValidationCheck => ({
    fn: "pattern",
    args: { pattern },
    message,
  }),
  min: (min: number, message?: string): ValidationCheck => ({
    fn: "min",
    args: { min },
    message: message ?? `Must be at least ${min}`,
  }),
  max: (max: number, message?: string): ValidationCheck => ({
    fn: "max",
    args: { max },
    message: message ?? `Must be at most ${max}`,
  }),
  url: (message = "Invalid URL"): ValidationCheck => ({ fn: "url", message }),
  matches: (
    otherPath: string,
    message = "Fields must match",
  ): ValidationCheck => ({
    fn: "matches",
    args: { other: { path: otherPath } },
    message,
  }),
};

// ── Action definitions (≈ json-render ActionDefinition) ─────────────────

export interface ActionDefinition<TParams = Record<string, unknown>> {
  /** Zod schema for params validation. */
  params?: z.ZodType<TParams>;
  /** Description for AI and documentation. */
  description?: string;
}

export type ActionHandler<
  TParams = Record<string, unknown>,
  TResult = unknown,
> = (
  params: TParams,
  state: Record<string, unknown>,
) => Promise<TResult> | TResult;

// ── Field definition (≈ json-render ComponentDefinition) ───────────────

export interface FieldDefinition<TValidator extends z.ZodType = z.ZodType> {
  /** Zod schema for validating field values. */
  validator: TValidator;
  /** Human-readable description (used for documentation / AI prompts). */
  description: string;
}

// ── Catalog (≈ json-render Catalog) ────────────────────────────────────

export interface FieldCatalog<
  TFields extends Record<string, FieldDefinition> = Record<
    string,
    FieldDefinition
  >,
  TActions extends Record<string, ActionDefinition> = Record<
    string,
    ActionDefinition
  >,
> {
  readonly fields: TFields;
  readonly fieldNames: string[];
  readonly actions: TActions;
  readonly actionNames: string[];
  readonly functions: Record<string, ValidationFunction>;
  /** Check if a field type is registered. */
  hasField(type: string): boolean;
  /** Check if an action is registered. */
  hasAction(name: string): boolean;
  /** Validate a value against a field type's Zod schema. */
  validate(type: string, value: unknown): z.ZodSafeParseResult<unknown>;
  /** Resolve a JSON Schema property + optional UI hint to a field type name. */
  resolveType(property: JsonSchemaProperty, hint?: ConfigUiHint): string;
  /** Generate an AI system prompt describing the catalog's capabilities. */
  prompt(): string;
}

/**
 * Catalog configuration.
 */
export interface CatalogConfig<
  TFields extends Record<string, FieldDefinition> = Record<
    string,
    FieldDefinition
  >,
  TActions extends Record<string, ActionDefinition> = Record<
    string,
    ActionDefinition
  >,
> {
  /** Field type definitions. */
  fields: TFields;
  /** Action definitions. */
  actions?: TActions;
  /** Custom validation functions. */
  functions?: Record<string, ValidationFunction>;
}

/**
 * Create a type-safe field catalog.
 *
 * Equivalent to json-render's `defineCatalog(schema, config)`.
 * Supports fields, actions, custom validation functions, and prompt generation.
 */
export function defineCatalog<
  TFields extends Record<string, FieldDefinition>,
  TActions extends Record<string, ActionDefinition> = Record<
    string,
    ActionDefinition
  >,
>(
  fieldsOrConfig: TFields | CatalogConfig<TFields, TActions>,
): FieldCatalog<TFields, TActions> {
  // Support both old (fields-only) and new (full config) signatures.
  // Old format: { text: { validator, ... }, ... } — values have "validator".
  // New format: { fields: { text: { ... } }, actions?: { ... } } — top-level "fields" key.
  const firstVal = Object.values(fieldsOrConfig)[0];
  const isPlainFields =
    firstVal &&
    typeof firstVal === "object" &&
    "validator" in (firstVal as Record<string, unknown>);
  const config: CatalogConfig<TFields, TActions> = isPlainFields
    ? { fields: fieldsOrConfig as TFields, actions: {} as TActions }
    : (fieldsOrConfig as CatalogConfig<TFields, TActions>);

  const fields = config.fields;
  const actions = config.actions ?? ({} as TActions);
  const functions = config.functions ?? {};
  const fieldNames = Object.keys(fields);
  const actionNames = Object.keys(actions);

  return {
    fields,
    fieldNames,
    actions,
    actionNames,
    functions,

    hasField(type: string): boolean {
      return type in fields;
    },

    hasAction(name: string): boolean {
      return name in actions;
    },

    validate(type: string, value: unknown) {
      const def = fields[type];
      if (!def)
        return {
          success: false,
          error: new z.ZodError([
            {
              code: "custom",
              message: `Unknown field type: ${type}`,
              path: [],
            },
          ]),
        } as z.ZodSafeParseResult<unknown>;
      return def.validator.safeParse(value);
    },

    resolveType(property: JsonSchemaProperty, hint?: ConfigUiHint): string {
      return resolveFieldType(property, hint, fieldNames);
    },

    prompt(): string {
      return generateCatalogPrompt(fields, actions, functions);
    },
  };
}

// ── Prompt generation (≈ json-render catalog.prompt()) ──────────────────

function generateCatalogPrompt(
  fields: Record<string, FieldDefinition>,
  actions: Record<string, ActionDefinition>,
  functions: Record<string, ValidationFunction>,
): string {
  const lines: string[] = [];

  lines.push("# Plugin Configuration UI Catalog");
  lines.push("");
  lines.push(
    "You are generating a plugin configuration form. Below are the available field types, actions, and validation functions.",
  );
  lines.push("");

  // Field types
  lines.push("## Field Types");
  lines.push("");
  for (const [name, def] of Object.entries(fields)) {
    lines.push(`- **${name}**: ${def.description}`);
  }
  lines.push("");

  // Actions
  if (Object.keys(actions).length > 0) {
    lines.push("## Actions");
    lines.push("");
    for (const [name, def] of Object.entries(actions)) {
      lines.push(`- **${name}**: ${def.description ?? "No description"}`);
    }
    lines.push("");
  }

  // Validation functions
  const allFunctions = { ...builtInValidators, ...functions };
  lines.push("## Validation Functions");
  lines.push("");
  lines.push(`Built-in: ${Object.keys(allFunctions).join(", ")}`);
  lines.push("");

  // Schema format
  lines.push("## Schema Format");
  lines.push("");
  lines.push(
    "Each field is described by a JSON Schema property + ConfigUiHint:",
  );
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        FIELD_NAME: {
          schema: { type: "string", description: "..." },
          hint: {
            type: "text",
            label: "...",
            help: "...",
            group: "...",
            validation: { checks: [{ fn: "required", message: "..." }] },
          },
        },
      },
      null,
      2,
    ),
  );
  lines.push("```");
  lines.push("");

  // Visibility
  lines.push("## Visibility Conditions");
  lines.push("");
  lines.push("Fields support `visible` conditions using LogicExpression:");
  lines.push('- `{ path: "FIELD_NAME" }` — truthy check');
  lines.push('- `{ eq: [{ path: "FIELD" }, "value"] }` — equality');
  lines.push(
    "- `{ and: [...] }`, `{ or: [...] }`, `{ not: {...} }` — logical operators",
  );
  lines.push("- `{ gt, gte, lt, lte }` — numeric comparisons");

  return lines.join("\n");
}

// ── Render props (≈ json-render ComponentRenderProps) ──────────────────

/**
 * Props passed to every field renderer function.
 *
 * Plugin authors implementing custom renderers receive this interface
 * as the single argument to their render function.
 *
 * @example
 * ```tsx
 * const MyCustomField: FieldRenderer = (props: FieldRenderProps) => (
 *   <input
 *     value={String(props.value ?? "")}
 *     onChange={(e) => props.onChange(e.target.value)}
 *     placeholder={props.hint.placeholder}
 *     disabled={props.readonly}
 *   />
 * );
 * ```
 */
export interface FieldRenderProps {
  /** Config key identifier (e.g., "OPENAI_API_KEY"). */
  key: string;
  /** Current field value, may be any JSON-compatible type. */
  value: unknown;
  /** JSON Schema property definition for this field. */
  schema: JsonSchemaProperty;
  /** UI rendering hints from the plugin manifest. */
  hint: ConfigUiHint;
  /** Resolved field type name from the catalog (e.g., "text", "select"). */
  fieldType: string;
  /** Callback to update the field value. */
  onChange: (value: unknown) => void;
  /** Whether the field currently has a configured value. */
  isSet: boolean;
  /** Whether the field is required by the schema. */
  required: boolean;
  /** Validation error messages for this field. */
  errors?: string[];
  /** Whether the field should be non-editable. */
  readonly?: boolean;
  /** For sensitive fields — async callback to fetch the real value from the server. */
  onReveal?: () => Promise<string | null>;
  /** Dispatch a named action with optional parameters. */
  onAction?: (
    action: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
}

/** A render function that returns a React node for a given field type. */
export type FieldRenderer = (props: FieldRenderProps) => ReactNode;

// ── Registry (≈ json-render ComponentRegistry + defineRegistry) ────────

export interface FieldRegistry<
  TFields extends Record<string, FieldDefinition> = Record<
    string,
    FieldDefinition
  >,
  TActions extends Record<string, ActionDefinition> = Record<
    string,
    ActionDefinition
  >,
> {
  readonly catalog: FieldCatalog<TFields, TActions>;
  readonly renderers: Record<string, FieldRenderer>;
  readonly actionHandlers: Record<string, ActionHandler>;
  /** Look up the renderer for a field type. Returns undefined if not registered. */
  resolve(type: string): FieldRenderer | undefined;
  /** Like resolve(), but falls back to the "text" renderer. */
  resolveOrFallback(type: string): FieldRenderer;
  /** Look up the handler for an action. */
  resolveAction(name: string): ActionHandler | undefined;
}

/**
 * Create a field registry that maps catalog field types to render functions.
 *
 * Equivalent to json-render's `defineRegistry(catalog, { components, actions })`.
 */
export function defineRegistry<
  TFields extends Record<string, FieldDefinition>,
  TActions extends Record<string, ActionDefinition> = Record<
    string,
    ActionDefinition
  >,
>(
  catalog: FieldCatalog<TFields, TActions>,
  renderers: Partial<Record<keyof TFields & string, FieldRenderer>>,
  actionHandlers?: Partial<Record<keyof TActions & string, ActionHandler>>,
): FieldRegistry<TFields, TActions> {
  const rendererMap = renderers as Record<string, FieldRenderer>;
  const handlerMap = (actionHandlers ?? {}) as Record<string, ActionHandler>;

  return {
    catalog,
    renderers: rendererMap,
    actionHandlers: handlerMap,

    resolve(type: string): FieldRenderer | undefined {
      return rendererMap[type];
    },

    resolveOrFallback(type: string): FieldRenderer {
      return rendererMap[type] ?? rendererMap.text;
    },

    resolveAction(name: string): ActionHandler | undefined {
      return handlerMap[name];
    },
  };
}

// ── Field type resolution ──────────────────────────────────────────────

/**
 * Resolve a JSON Schema property + ConfigUiHint to a field type name.
 *
 * Priority order:
 * 1. Explicit hint.type override (if it's a known type)
 * 2. hint.sensitive → "password"
 * 3. Schema enum/options → "select"
 * 4. Schema type + format heuristics
 * 5. Fallback → "text"
 */
function resolveFieldType(
  property: JsonSchemaProperty,
  hint: ConfigUiHint | undefined,
  knownTypes: string[],
): string {
  const knownSet = new Set(knownTypes);

  // 1. Explicit type override from hint
  const hintType = (hint as Record<string, unknown> | undefined)?.type as
    | string
    | undefined;
  if (hintType && knownSet.has(hintType)) return hintType;

  // 2. Sensitive → password
  if (hint?.sensitive) return knownSet.has("password") ? "password" : "text";

  // 3. Enum → select
  if (property.enum?.length || property.oneOf?.length) {
    return knownSet.has("select") ? "select" : "text";
  }

  // 4. Schema type + format
  const schemaType = Array.isArray(property.type)
    ? property.type[0]
    : property.type;

  switch (schemaType) {
    case "boolean":
      return knownSet.has("boolean") ? "boolean" : "text";
    case "number":
    case "integer":
      return knownSet.has("number") ? "number" : "text";
    case "array":
      if (property.items?.enum && knownSet.has("multiselect"))
        return "multiselect";
      return knownSet.has("array") ? "array" : "text";
    case "object":
      if (property.additionalProperties && knownSet.has("keyvalue"))
        return "keyvalue";
      return knownSet.has("json") ? "json" : "text";
    default:
      break;
  }

  // String format heuristics
  if (schemaType === "string" || !schemaType) {
    const fmt = property.format;
    if (fmt === "uri" || fmt === "url")
      return knownSet.has("url") ? "url" : "text";
    if (fmt === "email") return knownSet.has("email") ? "email" : "text";
    if (fmt === "date-time")
      return knownSet.has("datetime")
        ? "datetime"
        : knownSet.has("date")
          ? "date"
          : "text";
    if (fmt === "date") return knownSet.has("date") ? "date" : "text";
    if (fmt === "color") return knownSet.has("color") ? "color" : "text";

    // Multiline heuristic: maxLength > 200 or no maxLength with "text" hint
    if (property.maxLength && property.maxLength > 200) {
      return knownSet.has("textarea") ? "textarea" : "text";
    }
  }

  // 5. Fallback
  return "text";
}

// ── Default catalog ────────────────────────────────────────────────────

/**
 * The standard field catalog with 23 basic field types + built-in actions.
 */
export const defaultCatalog = defineCatalog({
  fields: {
    text: {
      validator: z.string(),
      description: "Single-line text input",
    },
    password: {
      validator: z.string(),
      description: "Masked input with show/hide toggle and API-backed reveal",
    },
    number: {
      validator: z.coerce.number(),
      description: "Numeric input with optional min/max/step",
    },
    boolean: {
      validator: z.coerce.boolean(),
      description: "Toggle switch (on/off)",
    },
    url: {
      validator: z.string(),
      description: "URL input with validation",
    },
    select: {
      validator: z.string(),
      description: "Single-select dropdown from enum values",
    },
    textarea: {
      validator: z.string(),
      description: "Multi-line text input for long values",
    },
    email: {
      validator: z.string().email().or(z.literal("")),
      description: "Email address input with validation",
    },
    color: {
      validator: z
        .string()
        .regex(/^#[0-9a-fA-F]{3,8}$/)
        .or(z.literal("")),
      description: "Color picker with hex value display",
    },
    radio: {
      validator: z.string(),
      description: "Single-select radio button group with descriptions",
    },
    multiselect: {
      validator: z.array(z.string()).or(z.string()),
      description: "Multi-select checkbox group for array values",
    },
    date: {
      validator: z.string(),
      description: "Date or date-time input",
    },
    json: {
      validator: z.string(),
      description: "JSON editor with syntax highlighting and validation",
    },
    code: {
      validator: z.string(),
      description: "Code editor with syntax highlighting",
    },
    array: {
      validator: z.array(z.unknown()),
      description: "Repeatable field group with add/remove items",
    },
    keyvalue: {
      validator: z.record(z.string(), z.string()),
      description: "Key-value pair editor with add/remove rows",
    },
    datetime: {
      validator: z.string(),
      description: "Date and time picker input",
    },
    file: {
      validator: z.string(),
      description: "File path or upload input",
    },
    custom: {
      validator: z.unknown(),
      description: "Plugin-provided custom React component",
    },
    markdown: {
      validator: z.string(),
      description: "Markdown editor with preview toggle",
    },
    "checkbox-group": {
      validator: z.array(z.string()).or(z.string()),
      description: "Checkbox group for multiple selections with descriptions",
    },
    group: {
      validator: z.record(z.string(), z.unknown()).or(z.string()),
      description: "Fieldset container for grouping related configuration",
    },
    table: {
      validator: z.array(z.record(z.string(), z.string())).or(z.string()),
      description: "Tabular data editor with add/remove rows",
    },
  },
  actions: {
    save: {
      params: z.object({}),
      description: "Save the current configuration",
    },
    reset: {
      params: z.object({}),
      description: "Reset all fields to their defaults",
    },
    testConnection: {
      params: z.object({ key: z.string().optional() }),
      description: "Test the connection/API key validity",
    },
  },
});

// ── Schema traversal helpers ───────────────────────────────────────────

export interface ResolvedField {
  key: string;
  schema: JsonSchemaProperty;
  hint: ConfigUiHint;
  fieldType: string;
  required: boolean;
  group: string;
  order: number;
  advanced: boolean;
  hidden: boolean;
  width: "full" | "half" | "third";
  visible?: VisibilityCondition;
  validation?: ValidationConfig;
  readonly: boolean;
}

/**
 * Walk a JSON Schema object's properties and resolve each to a field descriptor.
 *
 * This is the equivalent of json-render's spec traversal — it turns a declarative
 * schema into an ordered list of renderable field descriptors.
 */
export function resolveFields(
  schema: JsonSchemaObject | JsonSchemaProperty,
  hints: Record<string, ConfigUiHint>,
  catalog: FieldCatalog,
): ResolvedField[] {
  const properties = schema.properties ?? {};
  const requiredKeys = new Set(schema.required ?? []);
  const fields: ResolvedField[] = [];

  // Field types that are compact enough for half-width columns
  const HALF_WIDTH_TYPES = new Set([
    "text",
    "password",
    "number",
    "url",
    "email",
    "boolean",
    "select",
    "date",
    "datetime",
    "color",
    "file",
  ]);

  for (const [key, prop] of Object.entries(properties)) {
    const hint = hints[key] ?? {};
    const fieldType = catalog.resolveType(prop, hint);
    fields.push({
      key,
      schema: prop,
      hint,
      fieldType,
      required: requiredKeys.has(key),
      group: hint.group ?? "general",
      order: hint.order ?? 999,
      advanced: hint.advanced ?? false,
      hidden: hint.hidden ?? false,
      width: hint.width ?? (HALF_WIDTH_TYPES.has(fieldType) ? "half" : "full"),
      visible: hint.visible,
      validation: hint.validation,
      readonly: hint.readonly ?? false,
    });
  }

  // Sort: non-advanced before advanced, then by order, then alphabetically
  fields.sort((a, b) => {
    if (a.advanced !== b.advanced) return a.advanced ? 1 : -1;
    if (a.order !== b.order) return a.order - b.order;
    return a.key.localeCompare(b.key);
  });

  return fields;
}
