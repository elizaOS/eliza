/**
 * Validates a GenUI spec against the catalog: rejects unknown components and
 * disallowed action names before the renderer runs. Unsafe-field walks are
 * depth-, work-, and cycle-bounded so a hostile `data`/`metadata` nest cannot
 * RangeError the validator (which must never throw).
 */
import {
  ELIZA_GENUI_ALLOWED_ACTION_PREFIXES,
  isElizaGenUiActionNameAllowed,
  isElizaGenUiKnownComponent,
} from "./catalog";
import type {
  ElizaGenUiAction,
  ElizaGenUiComponent,
  ElizaGenUiSpec,
  ElizaGenUiValidationIssue,
  ElizaGenUiValidationOptions,
  ElizaGenUiValidationResult,
} from "./types";

const DEFAULT_MAX_COMPONENTS = 200;
const DEFAULT_MAX_JSON_BYTES = 65_536;
/** Nesting ceiling for unsafe-field walks. Honest specs are a handful deep. */
export const MAX_GENUI_UNSAFE_FIELD_DEPTH = 64;
/** Node ceiling across one unsafe-field walk, including leaves. */
export const MAX_GENUI_UNSAFE_FIELD_NODES = 2048;
const UNSAFE_FIELD_NAMES = new Set([
  "script",
  "code",
  "eval",
  "function",
  "dangerouslySetInnerHTML",
  "innerHTML",
  "onClick",
  "onChange",
  "onSubmit",
  "onKeyDown",
]);

type NormalizedValidationOptions = {
  maxComponents: number;
  maxJsonBytes: number;
  allowedActionPrefixes: readonly string[];
  allowedActionNames: readonly string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function addIssue(
  issues: ElizaGenUiValidationIssue[],
  issue: ElizaGenUiValidationIssue,
): void {
  issues.push(issue);
}

function jsonByteLength(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    // error-policy:J3 unserializable payload (cycles/BigInt) reads as the
    // explicit "size unknown" signal; the structural validators still run.
    return null;
  }
}

function isSafeImageSrc(value: string): boolean {
  if (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../")
  ) {
    return true;
  }
  if (value.startsWith("data:image/")) {
    return true;
  }
  try {
    const url = new URL(value);
    return ["http:", "https:", "blob:"].includes(url.protocol);
  } catch {
    return !value.includes(":");
  }
}

function validateUnsafeFields(
  value: unknown,
  issues: ElizaGenUiValidationIssue[],
  path: string,
  componentId?: string,
  depth = 0,
  ctx: { visits: number; ancestors: WeakSet<object> } = {
    visits: 0,
    ancestors: new WeakSet<object>(),
  },
): void {
  if (depth > MAX_GENUI_UNSAFE_FIELD_DEPTH) {
    addIssue(issues, {
      code: "unbounded_nest",
      message: `Generated UI value exceeds ${MAX_GENUI_UNSAFE_FIELD_DEPTH} nesting depth.`,
      componentId,
      path,
    });
    return;
  }
  ctx.visits += 1;
  if (ctx.visits > MAX_GENUI_UNSAFE_FIELD_NODES) {
    addIssue(issues, {
      code: "unbounded_nest",
      message: `Generated UI value exceeds ${MAX_GENUI_UNSAFE_FIELD_NODES} nodes.`,
      componentId,
      path,
    });
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (ctx.ancestors.has(value)) {
    addIssue(issues, {
      code: "unbounded_nest",
      message: "Generated UI value contains a cyclic object.",
      componentId,
      path,
    });
    return;
  }
  ctx.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        validateUnsafeFields(
          value[index],
          issues,
          `${path}/${index}`,
          componentId,
          depth + 1,
          ctx,
        );
      }
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (UNSAFE_FIELD_NAMES.has(key)) {
        addIssue(issues, {
          code: "unsafe_field",
          message: `Generated UI field "${key}" is not allowed.`,
          componentId,
          path: `${path}/${key}`,
        });
      }
      validateUnsafeFields(
        entry,
        issues,
        `${path}/${key}`,
        componentId,
        depth + 1,
        ctx,
      );
    }
  } finally {
    ctx.ancestors.delete(value);
  }
}

function validateAction(
  action: unknown,
  issues: ElizaGenUiValidationIssue[],
  componentId: string,
  options: Required<
    Pick<
      ElizaGenUiValidationOptions,
      "allowedActionPrefixes" | "allowedActionNames"
    >
  >,
): action is ElizaGenUiAction {
  const record = asRecord(action);
  const event = asRecord(record?.event);
  const name = event?.name;
  if (!record || !event || typeof name !== "string" || name.trim() === "") {
    addIssue(issues, {
      code: "invalid_action",
      message: "Action must use { event: { name, payload? } }.",
      componentId,
      path: `components/${componentId}/action`,
    });
    return false;
  }
  if (
    !isElizaGenUiActionNameAllowed(
      name,
      options.allowedActionPrefixes,
      options.allowedActionNames,
    )
  ) {
    addIssue(issues, {
      code: "invalid_action",
      message: `Action event "${name}" is not in the allowed registry.`,
      componentId,
      path: `components/${componentId}/action/event/name`,
    });
    return false;
  }
  return true;
}

function collectChildRefs(component: Record<string, unknown>): string[] {
  const refs: string[] = [];
  const child = component.child;
  if (typeof child === "string") {
    refs.push(child);
  }
  const children = component.children;
  if (Array.isArray(children)) {
    for (const entry of children) {
      if (typeof entry === "string") {
        refs.push(entry);
      }
    }
  }
  for (const key of ["entryPointChild", "contentChild"]) {
    const value = component[key];
    if (typeof value === "string") {
      refs.push(value);
    }
  }
  const tabItems = component.tabItems;
  if (Array.isArray(tabItems)) {
    for (const item of tabItems) {
      const record = asRecord(item);
      if (typeof record?.child === "string") {
        refs.push(record.child);
      }
    }
  }
  return refs;
}

function validateComponent(
  component: unknown,
  index: number,
  ids: Set<string>,
  childRefs: string[],
  issues: ElizaGenUiValidationIssue[],
  options: Required<
    Pick<
      ElizaGenUiValidationOptions,
      "allowedActionPrefixes" | "allowedActionNames"
    >
  >,
): component is ElizaGenUiComponent {
  const record = asRecord(component);
  const id = record?.id;
  const componentName = record?.component;
  const path = `components/${index}`;
  if (!record || typeof id !== "string" || id.trim() === "") {
    addIssue(issues, {
      code: "invalid_component",
      message: "Component id must be a non-empty string.",
      path,
    });
    return false;
  }
  if (ids.has(id)) {
    addIssue(issues, {
      code: "duplicate_id",
      message: `Duplicate component id "${id}".`,
      componentId: id,
      path,
    });
    return false;
  }
  ids.add(id);
  if (typeof componentName !== "string" || componentName.trim() === "") {
    addIssue(issues, {
      code: "invalid_component",
      message: "Component name must be a non-empty string.",
      componentId: id,
      path: `${path}/component`,
    });
    return false;
  }
  if (!isElizaGenUiKnownComponent(componentName)) {
    addIssue(issues, {
      code: "unknown_component",
      message: `Component "${componentName}" is not in the Eliza GenUI catalog.`,
      componentId: id,
      path: `${path}/component`,
    });
  }
  if (componentName === "Image" && typeof record.src === "string") {
    if (!isSafeImageSrc(record.src)) {
      addIssue(issues, {
        code: "unsafe_url",
        message: `Image source for "${id}" uses an unsafe protocol.`,
        componentId: id,
        path: `${path}/src`,
      });
    }
  }
  if ("action" in record) {
    validateAction(record.action, issues, id, options);
  }
  validateUnsafeFields(record, issues, path, id);
  childRefs.push(...collectChildRefs(record));
  return true;
}

function normalizeValidationOptions(
  validationOptions: ElizaGenUiValidationOptions,
): NormalizedValidationOptions {
  return {
    maxComponents: validationOptions.maxComponents ?? DEFAULT_MAX_COMPONENTS,
    maxJsonBytes: validationOptions.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES,
    allowedActionPrefixes:
      validationOptions.allowedActionPrefixes ??
      ELIZA_GENUI_ALLOWED_ACTION_PREFIXES,
    allowedActionNames: validationOptions.allowedActionNames ?? [],
  };
}

function validateJsonSize(
  value: unknown,
  issues: ElizaGenUiValidationIssue[],
  options: NormalizedValidationOptions,
): boolean {
  const byteLength = jsonByteLength(value);
  if (byteLength !== null && byteLength <= options.maxJsonBytes) return true;
  addIssue(issues, {
    code: "too_large",
    message: `Generated UI JSON must be serializable and at most ${options.maxJsonBytes} bytes.`,
  });
  return false;
}

function validateSpecHeader(
  record: Record<string, unknown>,
  issues: ElizaGenUiValidationIssue[],
): void {
  if (record.version !== "0.1") {
    addIssue(issues, {
      code: "invalid_version",
      message: 'Eliza GenUI version must be "0.1".',
      path: "version",
    });
  }
  if (record.a2uiVersion !== undefined && record.a2uiVersion !== "0.9") {
    addIssue(issues, {
      code: "invalid_version",
      message: 'A2UI compatibility version must be "0.9" when provided.',
      path: "a2uiVersion",
    });
  }
  if (typeof record.root !== "string" || record.root.trim() === "") {
    addIssue(issues, {
      code: "invalid_root",
      message: "Root component id must be a non-empty string.",
      path: "root",
    });
  }
}

function validateComponentsArray(
  record: Record<string, unknown>,
  issues: ElizaGenUiValidationIssue[],
  options: NormalizedValidationOptions,
): unknown[] | null {
  if (!Array.isArray(record.components)) {
    addIssue(issues, {
      code: "invalid_spec",
      message: "Generated UI spec must include a components array.",
      path: "components",
    });
    return null;
  }
  if (record.components.length > options.maxComponents) {
    addIssue(issues, {
      code: "too_many_components",
      message: `Generated UI spec has ${record.components.length} components; maximum is ${options.maxComponents}.`,
      path: "components",
    });
  }
  return record.components;
}

function validateComponents(
  components: unknown[],
  issues: ElizaGenUiValidationIssue[],
  options: NormalizedValidationOptions,
): { ids: Set<string>; childRefs: string[] } {
  const ids = new Set<string>();
  const childRefs: string[] = [];
  components.forEach((component, index) => {
    validateComponent(component, index, ids, childRefs, issues, options);
  });
  return { ids, childRefs };
}

function validateReferences(
  record: Record<string, unknown>,
  ids: Set<string>,
  childRefs: string[],
  issues: ElizaGenUiValidationIssue[],
): void {
  if (typeof record.root === "string" && !ids.has(record.root)) {
    addIssue(issues, {
      code: "invalid_root",
      message: `Root component "${record.root}" is missing.`,
      path: "root",
    });
  }
  for (const ref of childRefs) {
    if (!ids.has(ref)) {
      addIssue(issues, {
        code: "missing_child",
        message: `Child component "${ref}" is missing.`,
      });
    }
  }
}

export function validateElizaGenUiSpec(
  value: unknown,
  validationOptions: ElizaGenUiValidationOptions = {},
): ElizaGenUiValidationResult {
  const issues: ElizaGenUiValidationIssue[] = [];
  const options = normalizeValidationOptions(validationOptions);
  if (!validateJsonSize(value, issues, options))
    return { ok: false, errors: issues };
  const record = asRecord(value);
  if (!record) {
    addIssue(issues, {
      code: "invalid_spec",
      message: "Generated UI spec must be an object.",
    });
    return { ok: false, errors: issues };
  }
  validateSpecHeader(record, issues);
  const components = validateComponentsArray(record, issues, options);
  if (components === null) return { ok: false, errors: issues };
  validateUnsafeFields(record.data, issues, "data");
  validateUnsafeFields(record.metadata, issues, "metadata");
  const refs = validateComponents(components, issues, options);
  validateReferences(record, refs.ids, refs.childRefs, issues);
  if (issues.length > 0) {
    return { ok: false, errors: issues };
  }
  return { ok: true, spec: value as ElizaGenUiSpec };
}

export function assertValidElizaGenUiSpec(
  value: unknown,
  options?: ElizaGenUiValidationOptions,
): ElizaGenUiSpec {
  const result = validateElizaGenUiSpec(value, options);
  if (!result.ok) {
    throw new Error(result.errors.map((issue) => issue.message).join("\n"));
  }
  return result.spec;
}
