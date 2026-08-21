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
 * `evaluateLogicExpression` is depth-, visit-, and cycle-bounded so a
 * hostile plugin-config `visible` tree cannot stack-overflow the form
 * renderer. Plugin `pattern` validators use a deliberately constrained regex
 * dialect so a hostile UI spec cannot hang the form renderer (JS regex is
 * synchronous and cannot be timed out).
 *
 * @module config-catalog
 */

import { ElizaError } from "@elizaos/core";
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

/** Honest plugin-config visibility trees are a handful of and/or/not nodes. */
export const MAX_LOGIC_EXPRESSION_DEPTH = 32;
/** Node ceiling across the whole visibility walk. */
export const MAX_LOGIC_EXPRESSION_NODES = 2048;
/** Bounds one JSON Pointer leaf before segment parsing or state traversal. */
export const MAX_LOGIC_EXPRESSION_PATH_LENGTH = 2_048;
/** Bounds nested state reads even when every segment is one character. */
export const MAX_LOGIC_EXPRESSION_PATH_SEGMENTS = 64;
/** Bounds literal comparison work independently of path traversal. */
export const MAX_LOGIC_EXPRESSION_LITERAL_LENGTH = 2_048;
export const LOGIC_EXPRESSION_UNBOUNDED = "LOGIC_EXPRESSION_UNBOUNDED";
export const LOGIC_EXPRESSION_INVALID = "LOGIC_EXPRESSION_INVALID";

/** Honest plugin-config patterns are short format strings, not engines. */
export const MAX_UNTRUSTED_REGEX_PATTERN_LENGTH = 200;
/** Bound the subject a user-supplied pattern is tested against. */
export const MAX_UNTRUSTED_REGEX_INPUT_LENGTH = 4_096;

/**
 * Accept a linear-time subset of JavaScript regex syntax for agent-authored
 * config validators. Groups, alternation, backreferences, and more than one
 * variable repetition are excluded; fixed repetitions are bounded by the
 * subject ceiling. That policy is intentionally stricter than a blacklist:
 * every accepted expression is a flat sequence with at most one backtracking
 * choice, so nested or overlapping repetition cannot be smuggled through an
 * extra grouping layer.
 */
export function isSafeUntrustedRegexPattern(pattern: string): boolean {
  if (
    pattern.length === 0 ||
    pattern.length > MAX_UNTRUSTED_REGEX_PATTERN_LENGTH
  ) {
    return false;
  }
  try {
    new RegExp(pattern);
  } catch {
    // error-policy:J3 invalid user-supplied regex is not a validator
    return false;
  }

  let hasAtom = false;
  let variableRepetitions = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "\\") {
      const escaped = pattern[index + 1];
      if (!escaped || /[1-9k]/.test(escaped)) return false;
      index += 1;
      hasAtom = true;
      continue;
    }

    if (char === "[") {
      let closed = false;
      for (index += 1; index < pattern.length; index += 1) {
        if (pattern[index] === "\\") {
          index += 1;
        } else if (pattern[index] === "]") {
          closed = true;
          break;
        }
      }
      if (!closed) return false;
      hasAtom = true;
      continue;
    }

    if (char === "(" || char === ")" || char === "|") return false;

    if (char === "^" || char === "$") {
      if (
        (char === "^" && index !== 0) ||
        (char === "$" && index !== pattern.length - 1)
      ) {
        return false;
      }
      hasAtom = false;
      continue;
    }

    if (char === "*" || char === "+" || char === "?") {
      if (!hasAtom) return false;
      variableRepetitions += 1;
      if (variableRepetitions > 1) return false;
      hasAtom = false;
      continue;
    }

    if (char === "{") {
      if (!hasAtom) return false;
      const quantifier = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(index));
      if (!quantifier) return false;
      const minimum = Number(quantifier[1]);
      const hasComma = quantifier[0].includes(",");
      const maximum = hasComma
        ? quantifier[2] === ""
          ? undefined
          : Number(quantifier[2])
        : minimum;
      if (
        minimum > MAX_UNTRUSTED_REGEX_INPUT_LENGTH ||
        (maximum !== undefined && maximum > MAX_UNTRUSTED_REGEX_INPUT_LENGTH)
      ) {
        return false;
      }
      if (maximum === undefined || maximum !== minimum) {
        variableRepetitions += 1;
        if (variableRepetitions > 1) return false;
      }
      index += quantifier[0].length - 1;
      hasAtom = false;
      continue;
    }

    if (char === "}") return false;
    hasAtom = true;
  }
  return true;
}

/** Test an untrusted config value only after applying the shared safe dialect. */
export function matchesSafeUntrustedRegexPattern(
  pattern: string,
  value: string,
): boolean {
  if (
    value.length > MAX_UNTRUSTED_REGEX_INPUT_LENGTH ||
    !isSafeUntrustedRegexPattern(pattern)
  ) {
    return false;
  }
  return new RegExp(pattern).test(value);
}

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

function parsePathSegments(path: string): string[] {
  if (!path || path === "/") return [];
  return (path.startsWith("/") ? path.slice(1) : path)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Get a value from a nested object by slash-delimited path (JSON Pointer).
 *
 * @example
 * getByPath({ a: { b: 42 } }, "a/b") // → 42
 * getByPath({ items: [1, 2] }, "items/0") // → 1
 */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path || path === "/") return obj;
  const segments = parsePathSegments(path);
  let current: unknown = obj;
  for (const seg of segments) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(seg)) return undefined;
      current = current[Number(seg)];
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
  const segments = parsePathSegments(path);
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

type LogicWalkContext = {
  visits: number;
  visiting: WeakSet<object>;
};

function failLogicUnbounded(
  axis:
    | "depth"
    | "visits"
    | "cycle"
    | "path-length"
    | "path-segments"
    | "literal-length",
  context: Record<string, unknown>,
): never {
  const message =
    axis === "literal-length"
      ? `logic expression literal exceeds ${MAX_LOGIC_EXPRESSION_LITERAL_LENGTH} characters`
      : axis === "path-length"
        ? `logic expression path exceeds ${MAX_LOGIC_EXPRESSION_PATH_LENGTH} characters`
        : axis === "path-segments"
          ? `logic expression path exceeds ${MAX_LOGIC_EXPRESSION_PATH_SEGMENTS} segments`
          : axis === "depth"
            ? `logic expression exceeds ${MAX_LOGIC_EXPRESSION_DEPTH} nesting depth`
            : axis === "visits"
              ? `logic expression exceeds ${MAX_LOGIC_EXPRESSION_NODES} nodes`
              : "logic expression contains a cycle";
  throw new ElizaError(message, {
    code: LOGIC_EXPRESSION_UNBOUNDED,
    context,
    severity: "fatal",
  });
}

function failLogicInvalid(
  reason: string,
  context: Record<string, unknown>,
): never {
  throw new ElizaError(`logic expression is invalid: ${reason}`, {
    code: LOGIC_EXPRESSION_INVALID,
    context,
    severity: "fatal",
  });
}

const LOGIC_OPERATORS = [
  "and",
  "or",
  "not",
  "path",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;

function inspectOwnLogicProperty(
  object: object,
  key: PropertyKey,
  context: Record<string, unknown>,
): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(object, key);
  } catch {
    // error-policy:J3 hostile descriptor traps are invalid config metadata.
    failLogicInvalid("a property descriptor could not be inspected", context);
  }
}

function readLogicDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
  context: Record<string, unknown>,
): unknown {
  if (!descriptor || !("value" in descriptor)) {
    failLogicInvalid("accessor properties are not allowed", context);
  }
  return descriptor.value;
}

function readOwnLogicData(
  object: object,
  key: PropertyKey,
  context: Record<string, unknown>,
): unknown {
  return readLogicDataDescriptor(
    inspectOwnLogicProperty(object, key, context),
    context,
  );
}

function isLogicArray(
  value: unknown,
  context: Record<string, unknown>,
): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    // error-policy:J3 revoked proxies are invalid config metadata.
    failLogicInvalid("array identity could not be inspected", context);
  }
}

function readLogicArrayLength(
  value: unknown[],
  context: Record<string, unknown>,
): number {
  const length = readOwnLogicData(value, "length", context);
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    failLogicInvalid("array length is invalid", context);
  }
  return length as number;
}

function requireLogicPath(path: unknown): string {
  if (typeof path !== "string") {
    failLogicInvalid("path requires a string", { valueType: typeof path });
  }
  if (path.length > MAX_LOGIC_EXPRESSION_PATH_LENGTH) {
    failLogicUnbounded("path-length", {
      actual: path.length,
      max: MAX_LOGIC_EXPRESSION_PATH_LENGTH,
    });
  }
  const segmentCount = parsePathSegments(path).length;
  if (segmentCount > MAX_LOGIC_EXPRESSION_PATH_SEGMENTS) {
    failLogicUnbounded("path-segments", {
      actual: segmentCount,
      max: MAX_LOGIC_EXPRESSION_PATH_SEGMENTS,
    });
  }
  return path;
}

function resolveLogicDynamic(
  value: DynamicValue,
  state: Record<string, unknown>,
): unknown {
  if (value !== null && typeof value === "object") {
    const pathDescriptor = inspectOwnLogicProperty(value, "path", {
      operand: "dynamic-path",
    });
    if (pathDescriptor) {
      const path = readLogicDataDescriptor(pathDescriptor, {
        operand: "dynamic-path",
      });
      return getByPath(state, requireLogicPath(path));
    }
  }
  if (
    typeof value === "string" &&
    value.length > MAX_LOGIC_EXPRESSION_LITERAL_LENGTH
  ) {
    failLogicUnbounded("literal-length", {
      actual: value.length,
      max: MAX_LOGIC_EXPRESSION_LITERAL_LENGTH,
    });
  }
  return value;
}

function requireLogicTuple(
  value: unknown,
  operator: string,
): [DynamicValue, DynamicValue] {
  const context = { operator };
  if (!isLogicArray(value, context)) {
    failLogicInvalid(`${operator} requires exactly two operands`, { operator });
  }
  const length = readLogicArrayLength(value, context);
  if (length !== 2) {
    failLogicInvalid(`${operator} requires exactly two operands`, { operator });
  }
  return [
    readOwnLogicData(value, 0, { operator, index: 0 }) as DynamicValue,
    readOwnLogicData(value, 1, { operator, index: 1 }) as DynamicValue,
  ];
}

function requireLogicChildren(
  value: unknown,
  operator: "and" | "or",
  ctx: LogicWalkContext,
): LogicExpression[] {
  const context = { operator };
  if (!isLogicArray(value, context)) {
    failLogicInvalid(`${operator} requires an array`, { operator });
  }
  const length = readLogicArrayLength(value, context);
  const remainingVisits = MAX_LOGIC_EXPRESSION_NODES - ctx.visits;
  if (length > remainingVisits) {
    failLogicUnbounded("visits", {
      operator,
      visits: ctx.visits + length,
      max: MAX_LOGIC_EXPRESSION_NODES,
    });
  }
  const children: LogicExpression[] = [];
  for (let index = 0; index < length; index += 1) {
    children.push(
      readOwnLogicData(value, index, { operator, index }) as LogicExpression,
    );
  }
  return children;
}

/**
 * Evaluate a LogicExpression against a state model.
 *
 * Plugin config `visible` trees are attacker-controlled JSON. The walk is
 * depth-, visit-, and cycle-bounded; on origin a self-referential `and`
 * graph threw `RangeError: Maximum call stack size exceeded`.
 */
export function evaluateLogicExpression(
  expr: LogicExpression,
  state: Record<string, unknown>,
): boolean {
  return evalLogic(expr, state, 0, {
    visits: 0,
    visiting: new WeakSet(),
  });
}

function evalLogic(
  expr: LogicExpression,
  state: Record<string, unknown>,
  depth: number,
  ctx: LogicWalkContext,
): boolean {
  if (depth > MAX_LOGIC_EXPRESSION_DEPTH) {
    failLogicUnbounded("depth", { depth, max: MAX_LOGIC_EXPRESSION_DEPTH });
  }
  if (
    expr === null ||
    typeof expr !== "object" ||
    isLogicArray(expr, { depth, role: "node" })
  ) {
    failLogicInvalid("a node must be an object", {
      depth,
      valueType: typeof expr,
    });
  }
  if (ctx.visiting.has(expr)) {
    failLogicUnbounded("cycle", { depth });
  }
  ctx.visits += 1;
  if (ctx.visits > MAX_LOGIC_EXPRESSION_NODES) {
    failLogicUnbounded("visits", {
      visits: ctx.visits,
      max: MAX_LOGIC_EXPRESSION_NODES,
    });
  }
  ctx.visiting.add(expr);
  const operatorEntries = LOGIC_OPERATORS.flatMap((operator) => {
    const descriptor = inspectOwnLogicProperty(expr, operator, {
      depth,
      operator,
    });
    return descriptor ? [{ operator, descriptor }] : [];
  });
  if (operatorEntries.length !== 1) {
    failLogicInvalid("a node must contain exactly one logic operator", {
      depth,
      operators: operatorEntries.map(({ operator }) => operator),
    });
  }
  const { operator, descriptor } = operatorEntries[0];
  try {
    const operand = readLogicDataDescriptor(descriptor, { depth, operator });
    switch (operator) {
      case "and":
        return requireLogicChildren(operand, "and", ctx).every((child) =>
          evalLogic(child, state, depth + 1, ctx),
        );
      case "or":
        return requireLogicChildren(operand, "or", ctx).some((child) =>
          evalLogic(child, state, depth + 1, ctx),
        );
      case "not":
        return !evalLogic(operand as LogicExpression, state, depth + 1, ctx);
      case "path":
        return Boolean(getByPath(state, requireLogicPath(operand)));
      case "eq": {
        const [left, right] = requireLogicTuple(operand, "eq");
        return (
          resolveLogicDynamic(left, state) === resolveLogicDynamic(right, state)
        );
      }
      case "neq": {
        const [left, right] = requireLogicTuple(operand, "neq");
        return (
          resolveLogicDynamic(left, state) !== resolveLogicDynamic(right, state)
        );
      }
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const [left, right] = requireLogicTuple(operand, operator);
        const leftValue = resolveLogicDynamic(left, state);
        const rightValue = resolveLogicDynamic(right, state);
        if (typeof leftValue !== "number" || typeof rightValue !== "number") {
          return false;
        }
        if (operator === "gt") return leftValue > rightValue;
        if (operator === "gte") return leftValue >= rightValue;
        if (operator === "lt") return leftValue < rightValue;
        return leftValue <= rightValue;
      }
    }
    return failLogicInvalid("unsupported operator", { depth, operator });
  } finally {
    ctx.visiting.delete(expr);
  }
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
  return evaluateLogicExpression(condition as LogicExpression, state);
}

/** True when a draft/persisted config value counts as "filled in". */
export function isConfigValuePresent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function normalizeRequirementList(
  keys: string | string[] | undefined,
): string[] {
  if (keys == null) return [];
  const list = Array.isArray(keys) ? keys : [keys];
  return list.map((key) => key.trim()).filter((key) => key.length > 0);
}

/**
 * Whether `key` is present in live form values or already persisted (`setKeys`).
 * Sensitive secrets are often `isSet` without a echoed `currentValue`, so
 * `setKeys` is the only signal that unlocks dependent fields.
 */
export function isConfigKeySatisfied(
  key: string,
  values: Record<string, unknown>,
  setKeys?: ReadonlySet<string>,
): boolean {
  if (setKeys?.has(key)) return true;
  return isConfigValuePresent(values[key]);
}

/**
 * Build the state object used for `visible` path checks. Persisted-but-masked
 * secrets (in `setKeys`) are injected as `true` so `{ path: "TOKEN" }` works
 * even when the form value is empty for security.
 */
export function buildConfigVisibilityState(
  values: Record<string, unknown>,
  setKeys?: ReadonlySet<string>,
): Record<string, unknown> {
  if (!setKeys || setKeys.size === 0) return values;
  const state: Record<string, unknown> = { ...values };
  for (const key of setKeys) {
    if (!isConfigValuePresent(state[key])) {
      state[key] = true;
    }
  }
  return state;
}

/**
 * Evaluate `requires` / `requiresAny` / `visible` for a config field.
 * All declared gates must pass; missing gates are treated as open.
 */
export function evaluateFieldVisibility(options: {
  hidden?: boolean;
  requires?: string | string[];
  requiresAny?: string | string[];
  visible?: VisibilityCondition;
  values: Record<string, unknown>;
  setKeys?: ReadonlySet<string>;
}): boolean {
  if (options.hidden) return false;

  const requires = normalizeRequirementList(options.requires);
  if (
    requires.length > 0 &&
    !requires.every((key) =>
      isConfigKeySatisfied(key, options.values, options.setKeys),
    )
  ) {
    return false;
  }

  const requiresAny = normalizeRequirementList(options.requiresAny);
  if (
    requiresAny.length > 0 &&
    !requiresAny.some((key) =>
      isConfigKeySatisfied(key, options.values, options.setKeys),
    )
  ) {
    return false;
  }

  if (options.visible === undefined) return true;
  return evaluateVisibility(
    options.visible,
    buildConfigVisibilityState(options.values, options.setKeys),
  );
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
    return matchesSafeUntrustedRegexPattern(args.pattern, value);
  },
  min: (value, args) =>
    typeof value === "number" &&
    typeof args?.min === "number" &&
    value >= args.min,
  max: (value, args) =>
    typeof value === "number" &&
    typeof args?.max === "number" &&
    value <= args.max,
  numeric: (value) => {
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "string" || value.trim().length === 0) return false;
    return Number.isFinite(Number(value));
  },
  url: (value) => {
    if (typeof value !== "string") return false;
    try {
      new URL(value);
      return true;
    } catch {
      // error-policy:J3 invalid user-supplied URL -> validation fails
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
  /** All of these keys must be present (see {@link evaluateFieldVisibility}). */
  requires?: string | string[];
  /** Any one of these keys is enough. */
  requiresAny?: string | string[];
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
      requires: hint.requires,
      requiresAny: hint.requiresAny,
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
