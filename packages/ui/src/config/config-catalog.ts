/** Frontend field renderers over the runtime's declarative configuration catalog. */

import type {
  ActionDefinition,
  ActionHandler,
  FieldCatalog,
  FieldDefinition,
  JsonSchemaProperty,
} from "@elizaos/core/config/config-catalog";
import type { ConfigUiHint } from "@elizaos/core/contracts/host-types";
import type { ReactNode } from "react";

export * from "@elizaos/core/config/config-catalog";

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
