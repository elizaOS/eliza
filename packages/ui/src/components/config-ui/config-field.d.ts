import type {
  FieldRenderer,
  FieldRenderProps,
} from "../../config/config-catalog";
/** Single-line text input for unresolved field types. */
export declare function renderTextField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Masked password input with show/hide toggle and async onReveal for server-backed decryption. */
export declare function renderPasswordField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Numeric input with min/max/step attributes derived from schema and hints. */
export declare function renderNumberField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Pill-shaped toggle switch. Accepts boolean or string 'true'/'false' values. */
export declare function renderBooleanField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** URL input with type="url" browser validation. */
export declare function renderUrlField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Dropdown select. Options from hint.options or schema.enum. */
export declare function RenderSelectField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Multi-line text input with auto-resize. Auto-detected for maxLength > 200. */
export declare function renderTextareaField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Email input with type="email" browser validation. */
export declare function renderEmailField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Color picker swatch paired with a hex text input. */
export declare function renderColorField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Vertical radio button group. Supports per-option descriptions. */
export declare function renderRadioField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Checkbox group for selecting multiple values from options. */
export declare function renderMultiselectField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Native date picker input. */
export declare function renderDateField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** JSON editor textarea with parse validation on blur. Shows inline error for invalid JSON. */
export declare function renderJsonField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Monospaced code editor textarea for templates and snippets. */
export declare function renderCodeField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Add/remove items list. Max 100 items. Parses comma-separated strings. */
export declare function renderArrayField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Key-value pair editor with add/remove rows. Blocks prototype pollution keys. */
export declare function renderKeyValueField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Combined date and time picker (datetime-local). */
export declare function renderDatetimeField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** File path text input with path traversal guard. */
export declare function RenderFileField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Placeholder for plugin-provided custom React components. */
export declare function RenderCustomField(
  props: FieldRenderProps,
): import("react/jsx-runtime").JSX.Element;
/** Markdown textarea with Edit/Preview toggle. */
export declare const renderMarkdownField: FieldRenderer;
/** Vertical checkbox list with per-option descriptions and accent highlighting. */
export declare const renderCheckboxGroupField: FieldRenderer;
/** Fieldset container with legend label. */
export declare const renderGroupField: FieldRenderer;
/** Tabular data editor with configurable columns. Max 50 rows. */
export declare const renderTableField: FieldRenderer;
export declare const defaultRenderers: Record<string, FieldRenderer>;
/**
 * Wraps a field renderer with the standard label row, env key display,
 * help text, and error messages.
 */
export declare function ConfigField({
  renderProps,
  renderer,
  pluginId,
}: {
  renderProps: FieldRenderProps;
  renderer: FieldRenderer;
  pluginId?: string;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=config-field.d.ts.map
