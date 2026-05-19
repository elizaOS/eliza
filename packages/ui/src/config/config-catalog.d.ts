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
import type { ConfigUiHint, DynamicValue, LogicExpression, ValidationCheck, ValidationConfig, VisibilityCondition } from "../types";
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
/**
 * Get a value from a nested object by slash-delimited path (JSON Pointer).
 *
 * @example
 * getByPath({ a: { b: 42 } }, "a/b") // → 42
 * getByPath({ items: [1, 2] }, "items/0") // → 1
 */
export declare function getByPath(obj: unknown, path: string): unknown;
/**
 * Set a value in a nested object by slash-delimited path.
 */
export declare function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void;
/**
 * Resolve a DynamicValue — if it's a {path} reference, look up in state.
 */
export declare function resolveDynamic<T>(value: DynamicValue<T>, state: Record<string, unknown>): T | undefined;
/**
 * Search for a field value by name — ported from json-render's dashboard example.
 *
 * Resolution order:
 * 1. Direct params lookup
 * 2. Params with path format (JSON Pointer)
 * 3. State walk through common form prefixes (form, newItem, create, edit, root)
 */
export declare function findFormValue(fieldName: string, params?: Record<string, unknown>, state?: Record<string, unknown>): unknown;
/**
 * Interpolate `{{path}}` references in a template string using context values.
 *
 * Useful for action onSuccess/onError messages that reference state values.
 *
 * @example
 * interpolateString("Created {{/form/name}} successfully", { form: { name: "Foo" } })
 * // → "Created Foo successfully"
 */
export declare function interpolateString(template: string, context: Record<string, unknown>): string;
/**
 * Evaluate a LogicExpression against a state model.
 */
export declare function evaluateLogicExpression(expr: LogicExpression, state: Record<string, unknown>): boolean;
/**
 * Evaluate a full VisibilityCondition.
 */
export declare function evaluateVisibility(condition: VisibilityCondition | undefined, state: Record<string, unknown>): boolean;
export declare const visibility: {
    always: true;
    never: false;
    when: (path: string) => VisibilityCondition;
    and: (...conditions: LogicExpression[]) => LogicExpression;
    or: (...conditions: LogicExpression[]) => LogicExpression;
    not: (condition: LogicExpression) => LogicExpression;
    eq: (left: DynamicValue, right: DynamicValue) => LogicExpression;
    neq: (left: DynamicValue, right: DynamicValue) => LogicExpression;
    gt: (left: DynamicValue<number>, right: DynamicValue<number>) => LogicExpression;
    gte: (left: DynamicValue<number>, right: DynamicValue<number>) => LogicExpression;
    lt: (left: DynamicValue<number>, right: DynamicValue<number>) => LogicExpression;
    lte: (left: DynamicValue<number>, right: DynamicValue<number>) => LogicExpression;
};
export type ValidationFunction = (value: unknown, args?: Record<string, unknown>) => boolean;
export declare const builtInValidators: Record<string, ValidationFunction>;
/**
 * Run validation checks for a field value.
 */
export declare function runValidation(config: ValidationConfig, value: unknown, state: Record<string, unknown>, customFunctions?: Record<string, ValidationFunction>): {
    valid: boolean;
    errors: string[];
};
export declare const check: {
    required: (message?: string) => ValidationCheck;
    email: (message?: string) => ValidationCheck;
    minLength: (min: number, message?: string) => ValidationCheck;
    maxLength: (max: number, message?: string) => ValidationCheck;
    pattern: (pattern: string, message?: string) => ValidationCheck;
    min: (min: number, message?: string) => ValidationCheck;
    max: (max: number, message?: string) => ValidationCheck;
    url: (message?: string) => ValidationCheck;
    matches: (otherPath: string, message?: string) => ValidationCheck;
};
export interface ActionDefinition<TParams = Record<string, unknown>> {
    /** Zod schema for params validation. */
    params?: z.ZodType<TParams>;
    /** Description for AI and documentation. */
    description?: string;
}
export type ActionHandler<TParams = Record<string, unknown>, TResult = unknown> = (params: TParams, state: Record<string, unknown>) => Promise<TResult> | TResult;
export interface FieldDefinition<TValidator extends z.ZodType = z.ZodType> {
    /** Zod schema for validating field values. */
    validator: TValidator;
    /** Human-readable description (used for documentation / AI prompts). */
    description: string;
}
export interface FieldCatalog<TFields extends Record<string, FieldDefinition> = Record<string, FieldDefinition>, TActions extends Record<string, ActionDefinition> = Record<string, ActionDefinition>> {
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
export interface CatalogConfig<TFields extends Record<string, FieldDefinition> = Record<string, FieldDefinition>, TActions extends Record<string, ActionDefinition> = Record<string, ActionDefinition>> {
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
export declare function defineCatalog<TFields extends Record<string, FieldDefinition>, TActions extends Record<string, ActionDefinition> = Record<string, ActionDefinition>>(fieldsOrConfig: TFields | CatalogConfig<TFields, TActions>): FieldCatalog<TFields, TActions>;
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
    onAction?: (action: string, params?: Record<string, unknown>) => Promise<unknown>;
}
/** A render function that returns a React node for a given field type. */
export type FieldRenderer = (props: FieldRenderProps) => ReactNode;
export interface FieldRegistry<TFields extends Record<string, FieldDefinition> = Record<string, FieldDefinition>, TActions extends Record<string, ActionDefinition> = Record<string, ActionDefinition>> {
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
export declare function defineRegistry<TFields extends Record<string, FieldDefinition>, TActions extends Record<string, ActionDefinition> = Record<string, ActionDefinition>>(catalog: FieldCatalog<TFields, TActions>, renderers: Partial<Record<keyof TFields & string, FieldRenderer>>, actionHandlers?: Partial<Record<keyof TActions & string, ActionHandler>>): FieldRegistry<TFields, TActions>;
/**
 * The standard field catalog with 23 basic field types + built-in actions.
 */
export declare const defaultCatalog: FieldCatalog<{
    text: {
        validator: z.ZodString;
        description: string;
    };
    password: {
        validator: z.ZodString;
        description: string;
    };
    number: {
        validator: z.ZodCoercedNumber<unknown>;
        description: string;
    };
    boolean: {
        validator: z.ZodCoercedBoolean<unknown>;
        description: string;
    };
    url: {
        validator: z.ZodString;
        description: string;
    };
    select: {
        validator: z.ZodString;
        description: string;
    };
    textarea: {
        validator: z.ZodString;
        description: string;
    };
    email: {
        validator: z.ZodUnion<[z.ZodString, z.ZodLiteral<"">]>;
        description: string;
    };
    color: {
        validator: z.ZodUnion<[z.ZodString, z.ZodLiteral<"">]>;
        description: string;
    };
    radio: {
        validator: z.ZodString;
        description: string;
    };
    multiselect: {
        validator: z.ZodUnion<[z.ZodArray<z.ZodString>, z.ZodString]>;
        description: string;
    };
    date: {
        validator: z.ZodString;
        description: string;
    };
    json: {
        validator: z.ZodString;
        description: string;
    };
    code: {
        validator: z.ZodString;
        description: string;
    };
    array: {
        validator: z.ZodArray<z.ZodUnknown>;
        description: string;
    };
    keyvalue: {
        validator: z.ZodRecord<z.ZodString, z.ZodString>;
        description: string;
    };
    datetime: {
        validator: z.ZodString;
        description: string;
    };
    file: {
        validator: z.ZodString;
        description: string;
    };
    custom: {
        validator: z.ZodUnknown;
        description: string;
    };
    markdown: {
        validator: z.ZodString;
        description: string;
    };
    "checkbox-group": {
        validator: z.ZodUnion<[z.ZodArray<z.ZodString>, z.ZodString]>;
        description: string;
    };
    group: {
        validator: z.ZodUnion<[z.ZodRecord<z.ZodString, z.ZodUnknown>, z.ZodString]>;
        description: string;
    };
    table: {
        validator: z.ZodUnion<[z.ZodArray<z.ZodRecord<z.ZodString, z.ZodString>>, z.ZodString]>;
        description: string;
    };
}, {
    save: {
        params: z.ZodObject<{}, z.core.$strip>;
        description: string;
    };
    reset: {
        params: z.ZodObject<{}, z.core.$strip>;
        description: string;
    };
    testConnection: {
        params: z.ZodObject<{
            key: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        description: string;
    };
}>;
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
export declare function resolveFields(schema: JsonSchemaObject | JsonSchemaProperty, hints: Record<string, ConfigUiHint>, catalog: FieldCatalog): ResolvedField[];
//# sourceMappingURL=config-catalog.d.ts.map