/**
 * Pure evaluation helpers for `UiRenderer`: resolves a spec's visibility
 * conditions and validation checks against state/auth, sanitizes link hrefs
 * against a protocol denylist (blocks javascript/data/vbscript/file to prevent
 * XSS from agent-authored specs), and enumerates the supported component types.
 * No React — logic only, so it can be unit-tested in isolation.
 */
import { getByPath } from "../../config/config-catalog";
import type {
  AuthState,
  UiSpecValidationCheck,
  UiSpecVisibilityCondition,
} from "../../config/ui-spec";

const BLOCKED_LINK_PROTOCOLS = new Set([
  "javascript",
  "data",
  "vbscript",
  "file",
]);

// ── Visibility evaluation ────────────────────────────────────────────

export function evaluateUiVisibility(
  condition: UiSpecVisibilityCondition | undefined,
  state: Record<string, unknown>,
  auth?: AuthState,
): boolean {
  if (!condition) return true;

  // Path-based
  if ("path" in condition && "operator" in condition) {
    const val = getByPath(state, condition.path);
    const target = condition.value;
    switch (condition.operator) {
      case "eq":
        return val === target;
      case "ne":
        return val !== target;
      case "gt":
        return Number(val) > Number(target);
      case "gte":
        return Number(val) >= Number(target);
      case "lt":
        return Number(val) < Number(target);
      case "lte":
        return Number(val) <= Number(target);
      default:
        return true;
    }
  }

  // Auth-based
  if ("auth" in condition) {
    if (!auth) return false;
    switch (condition.auth) {
      case "signedIn":
        return auth.isSignedIn;
      case "signedOut":
        return !auth.isSignedIn;
      case "admin":
        return auth.roles?.includes("admin") ?? false;
      default:
        return auth.roles?.includes(condition.auth) ?? false;
    }
  }

  // Logic combinators
  if ("and" in condition)
    return condition.and.every((c: UiSpecVisibilityCondition) =>
      evaluateUiVisibility(c, state, auth),
    );
  if ("or" in condition)
    return condition.or.some((c: UiSpecVisibilityCondition) =>
      evaluateUiVisibility(c, state, auth),
    );
  if ("not" in condition)
    return !evaluateUiVisibility(condition.not, state, auth);

  return true;
}

export function sanitizeLinkHref(href: unknown): string {
  // Strip ASCII control chars (tab, LF, CR) that browsers silently remove
  // during URL parsing, preventing bypass attacks like "java\nscript:alert(1)".
  const raw = String(href ?? "#")
    .trim()
    .replace(/[\t\n\r]/g, "");
  if (!raw) return "#";

  // Keep relative/hash links unchanged.
  if (
    raw.startsWith("#") ||
    raw.startsWith("/") ||
    raw.startsWith("./") ||
    raw.startsWith("../") ||
    raw.startsWith("?")
  ) {
    return raw;
  }

  const match = /^([a-zA-Z][a-zA-Z\d+.-]*):/.exec(raw);
  if (!match) return raw;

  const protocol = match[1].toLowerCase();
  if (BLOCKED_LINK_PROTOCOLS.has(protocol)) return "#";

  return raw;
}

// ── Built-in validators ─────────────────────────────────────────────

const BUILTIN_VALIDATORS: Record<
  string,
  (value: unknown, args?: Record<string, unknown>) => boolean
> = {
  required: (v) => v != null && v !== "",
  email: (v) =>
    typeof v === "string" &&
    v.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  minLength: (v, args) =>
    typeof v === "string" && v.length >= Number(args?.length ?? 0),
  maxLength: (v, args) =>
    typeof v === "string" && v.length <= Number(args?.length ?? Infinity),
  pattern: (v, args) => {
    if (typeof v !== "string" || !args?.pattern) return true;
    try {
      return new RegExp(String(args.pattern)).test(v);
    } catch {
      return true;
    }
  },
  min: (v, args) => Number(v) >= Number(args?.value ?? -Infinity),
  max: (v, args) => Number(v) <= Number(args?.value ?? Infinity),
};

// ── Validation runner ───────────────────────────────────────────────

export function runValidation(
  checks: UiSpecValidationCheck[],
  value: unknown,
  customValidators?: Record<
    string,
    (
      value: unknown,
      args?: Record<string, unknown>,
    ) => boolean | Promise<boolean>
  >,
): string[] {
  const errors: string[] = [];
  for (const check of checks) {
    const fn = BUILTIN_VALIDATORS[check.fn] ?? customValidators?.[check.fn];
    if (fn) {
      const result = fn(value, check.args);
      // Handle sync validators only (async handled separately)
      if (result === false) errors.push(check.message);
    }
  }
  return errors;
}

// ── Supported component vocabulary ──────────────────────────────────
//
// Canonical list of UiRenderer component type names. Single source of truth
// for the key set of the `COMPONENTS` registry in `ui-renderer.tsx` (which is
// typed against this list so the two cannot drift).

export const SUPPORTED_UI_COMPONENT_TYPES = [
  // Layout
  "Stack",
  "Grid",
  "Card",
  "Separator",
  // Typography
  "Heading",
  "Text",
  // Form
  "Input",
  "Textarea",
  "Select",
  "Checkbox",
  "Radio",
  "Switch",
  "Slider",
  "Toggle",
  "ToggleGroup",
  "ButtonGroup",
  // Data
  "Table",
  "Carousel",
  "Badge",
  "Avatar",
  "Image",
  // Feedback
  "Alert",
  "Progress",
  "Rating",
  "Skeleton",
  "Spinner",
  // Navigation
  "Button",
  "Link",
  "DropdownMenu",
  "Tabs",
  "Pagination",
  // Metric
  "Metric",
  // Visualization
  "BarGraph",
  "LineGraph",
  // Interaction
  "Tooltip",
  "Popover",
  "Collapsible",
  "Accordion",
  "Dialog",
  "Drawer",
] as const;

export type SupportedUiComponentType =
  (typeof SUPPORTED_UI_COMPONENT_TYPES)[number];

/** Get the full list of supported component types. */
export function getSupportedComponents(): string[] {
  return [...SUPPORTED_UI_COMPONENT_TYPES];
}
