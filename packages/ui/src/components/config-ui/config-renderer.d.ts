import React from "react";
import type { FieldRegistry, FieldRenderer, FieldRenderProps, JsonSchemaObject } from "../../config/config-catalog";
import type { ConfigUiHint, PluginUiTheme } from "../../types";
export interface ConfigRendererProps {
    /** JSON Schema describing the config structure (type: "object"). */
    schema: JsonSchemaObject | null;
    /** UI rendering hints keyed by property name. */
    hints?: Record<string, ConfigUiHint>;
    /** Current config values keyed by property name. */
    values?: Record<string, unknown>;
    /** Which keys currently have values set (for status dots). */
    setKeys?: Set<string>;
    /** Field registry (catalog + renderers + action handlers). */
    registry: FieldRegistry;
    /** Plugin ID (used for revealing sensitive values via API). */
    pluginId?: string;
    /** Callback to reveal a sensitive field's real value. */
    revealSecret?: (pluginId: string, key: string) => Promise<string | null>;
    /** Callback when a field value changes. */
    onChange?: (key: string, value: unknown) => void;
    /** Render function for each field — receives renderProps and the resolved renderer. */
    renderField?: (renderProps: FieldRenderProps, renderer: FieldRenderer) => React.ReactNode;
    /** Show a validation error summary above the form fields when errors exist. Defaults to true. */
    showValidationSummary?: boolean;
    /** Partial theme overrides for plugin UI tokens. */
    theme?: Partial<PluginUiTheme>;
}
/** Handle exposed by ConfigRenderer via ref for parent-driven validation. */
export interface ConfigRendererHandle {
    /** Run validation on all visible fields. Returns true if the form is valid (no errors). */
    validateAll: () => boolean;
}
export declare const ConfigRenderer: React.ForwardRefExoticComponent<ConfigRendererProps & React.RefAttributes<ConfigRendererHandle>>;
/** The default registry wiring defaultCatalog → defaultRenderers. */
export declare const defaultRegistry: FieldRegistry<{
    text: {
        validator: import("zod").ZodString;
        description: string;
    };
    password: {
        validator: import("zod").ZodString;
        description: string;
    };
    number: {
        validator: import("zod").ZodCoercedNumber<unknown>;
        description: string;
    };
    boolean: {
        validator: import("zod").ZodCoercedBoolean<unknown>;
        description: string;
    };
    url: {
        validator: import("zod").ZodString;
        description: string;
    };
    select: {
        validator: import("zod").ZodString;
        description: string;
    };
    textarea: {
        validator: import("zod").ZodString;
        description: string;
    };
    email: {
        validator: import("zod").ZodUnion<[import("zod").ZodString, import("zod").ZodLiteral<"">]>;
        description: string;
    };
    color: {
        validator: import("zod").ZodUnion<[import("zod").ZodString, import("zod").ZodLiteral<"">]>;
        description: string;
    };
    radio: {
        validator: import("zod").ZodString;
        description: string;
    };
    multiselect: {
        validator: import("zod").ZodUnion<[import("zod").ZodArray<import("zod").ZodString>, import("zod").ZodString]>;
        description: string;
    };
    date: {
        validator: import("zod").ZodString;
        description: string;
    };
    json: {
        validator: import("zod").ZodString;
        description: string;
    };
    code: {
        validator: import("zod").ZodString;
        description: string;
    };
    array: {
        validator: import("zod").ZodArray<import("zod").ZodUnknown>;
        description: string;
    };
    keyvalue: {
        validator: import("zod").ZodRecord<import("zod").ZodString, import("zod").ZodString>;
        description: string;
    };
    datetime: {
        validator: import("zod").ZodString;
        description: string;
    };
    file: {
        validator: import("zod").ZodString;
        description: string;
    };
    custom: {
        validator: import("zod").ZodUnknown;
        description: string;
    };
    markdown: {
        validator: import("zod").ZodString;
        description: string;
    };
    "checkbox-group": {
        validator: import("zod").ZodUnion<[import("zod").ZodArray<import("zod").ZodString>, import("zod").ZodString]>;
        description: string;
    };
    group: {
        validator: import("zod").ZodUnion<[import("zod").ZodRecord<import("zod").ZodString, import("zod").ZodUnknown>, import("zod").ZodString]>;
        description: string;
    };
    table: {
        validator: import("zod").ZodUnion<[import("zod").ZodArray<import("zod").ZodRecord<import("zod").ZodString, import("zod").ZodString>>, import("zod").ZodString]>;
        description: string;
    };
}, {
    save: {
        params: import("zod").ZodObject<{}, import("zod/v4/core").$strip>;
        description: string;
    };
    reset: {
        params: import("zod").ZodObject<{}, import("zod/v4/core").$strip>;
        description: string;
    };
    testConnection: {
        params: import("zod").ZodObject<{
            key: import("zod").ZodOptional<import("zod").ZodString>;
        }, import("zod/v4/core").$strip>;
        description: string;
    };
}>;
/**
 * Convenience hook that creates a ref for ConfigRenderer and exposes
 * a `validateAll()` function the parent can call before submitting.
 *
 * @example
 * ```tsx
 * const { configRef, validateAll } = useConfigValidation();
 *
 * const handleSave = () => {
 *   if (!validateAll()) return; // form has errors
 *   // proceed with save
 * };
 *
 * return <ConfigRenderer ref={configRef} ... />;
 * ```
 */
export declare function useConfigValidation(): {
    configRef: React.RefObject<ConfigRendererHandle | null>;
    validateAll: () => boolean;
};
//# sourceMappingURL=config-renderer.d.ts.map