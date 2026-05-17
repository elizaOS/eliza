import type { AuthState, UiSpec, UiSpecValidationCheck, UiSpecVisibilityCondition } from "../../config/ui-spec";
export declare function evaluateUiVisibility(condition: UiSpecVisibilityCondition | undefined, state: Record<string, unknown>, auth?: AuthState): boolean;
export declare function sanitizeLinkHref(href: unknown): string;
export declare function runValidation(checks: UiSpecValidationCheck[], value: unknown, customValidators?: Record<string, (value: unknown, args?: Record<string, unknown>) => boolean | Promise<boolean>>): string[];
export interface UiRendererProps {
    spec: UiSpec;
    onAction?: (action: string, params?: Record<string, unknown>) => void;
    loading?: boolean;
    auth?: AuthState;
    validators?: Record<string, (value: unknown, args?: Record<string, unknown>) => boolean | Promise<boolean>>;
}
export declare function UiRenderer({ spec, onAction, loading, auth, validators, }: UiRendererProps): import("react/jsx-runtime").JSX.Element;
/** Get the full list of supported component types. */
export declare function getSupportedComponents(): string[];
//# sourceMappingURL=ui-renderer.d.ts.map