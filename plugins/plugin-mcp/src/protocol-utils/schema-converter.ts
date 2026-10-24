/** Converts MCP JSON Schemas into runtime action parameters without dropping constraints. */
import { isDeepStrictEqual } from "node:util";

export interface McpInputSchema {
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** MCP → runtime action parameter row (replaces removed @elizaos/core ActionParameter export). */
type RuntimeParameterType = "string" | "number" | "boolean" | "object" | "array";

export interface ActionParameter {
  name: string;
  description: string;
  required?: boolean;
  schema: {
    /** Omitted for a mixed union, which is described by `anyOf` instead. */
    type?: RuntimeParameterType;
    /** Mixed union branches. A sibling `type` would contradict the other branch. */
    anyOf?: ReadonlyArray<{ type: RuntimeParameterType }>;
    default?: unknown;
    enum?: string[];
    enumValues?: string[];
  };
}

interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  items?: JsonSchemaProperty | JsonSchemaProperty[];
  contains?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
  minProperties?: number;
  maxProperties?: number;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  pattern?: string;
  $ref?: string;
  oneOf?: JsonSchemaProperty[];
  anyOf?: JsonSchemaProperty[];
  allOf?: JsonSchemaProperty[];
  nullable?: boolean;
}

/**
 * JSON Schema type names a property accepts.
 *
 * A property does not need a top-level `type`: `anyOf`/`oneOf` branch types are
 * just as binding, and pydantic/FastMCP emit `{"anyOf":[{"type":"string"},
 * {"type":"null"}]}` for `Optional[str]`. Ignoring those branches declared the
 * argument as an object, so the model was told to send an object and every
 * correct string argument failed validation.
 */
const MAX_TYPE_BRANCH_DEPTH = 8;

/** Every type name a sibling `type` keyword allows. */
function typeNameSet(declared: JsonSchemaProperty["type"]): Set<string> {
  const names = new Set<string>();
  if (typeof declared === "string") names.add(declared);
  else if (Array.isArray(declared)) {
    for (const entry of declared) {
      if (typeof entry === "string") names.add(entry);
    }
  }
  return names;
}

/**
 * Types that satisfy both groups.
 *
 * `integer` is a narrower `number`, so that pair still describes one runtime
 * type instead of an empty intersection.
 */
function intersectTypeNames(left: Set<string>, right: Set<string>): Set<string> {
  const shared = new Set<string>();
  for (const name of left) {
    if (right.has(name)) shared.add(name);
    else if (name === "integer" && right.has("number")) shared.add("integer");
    else if (name === "number" && right.has("integer")) shared.add("integer");
  }
  return shared;
}

/**
 * JSON Schema type names a property accepts.
 *
 * A property does not need a top-level `type`: `anyOf`/`oneOf` branch types are
 * just as binding, and pydantic/FastMCP emit `{"anyOf":[{"type":"string"},
 * {"type":"null"}]}` for `Optional[str]`. Ignoring those branches declared the
 * argument as an object, so the model was told to send an object and every
 * correct string argument failed validation.
 *
 * `type`, `anyOf`, `oneOf` and `allOf` are simultaneous constraints, not
 * alternatives: a value must satisfy the sibling type, every `allOf` branch,
 * and one branch of each union. The groups are therefore intersected. `null`
 * means the constraints share no type, so the property accepts no value.
 */
function propertyTypeNames(prop: JsonSchemaProperty | undefined, depth = 0): string[] | null {
  if (!prop || depth > MAX_TYPE_BRANCH_DEPTH) return [];

  let names: Set<string> | undefined;
  const declared = typeNameSet(prop.type);
  if (declared.size > 0) names = declared;

  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = prop[key];
    if (!Array.isArray(variants) || variants.length === 0) continue;
    const alternatives = new Set<string>();
    let untyped = false;
    for (const variant of variants) {
      const branchNames = propertyTypeNames(variant, depth + 1);
      // A branch that accepts no value is no alternative.
      if (branchNames === null) continue;
      if (branchNames.length === 0) {
        untyped = true;
        continue;
      }
      for (const name of branchNames) alternatives.add(name);
    }
    if (alternatives.size === 0) {
      // No branch names a type: the keyword adds no bound. If every branch is
      // unsatisfiable instead, no value can satisfy the union.
      if (untyped) continue;
      return null;
    }
    names = names ? intersectTypeNames(names, alternatives) : alternatives;
  }

  // `allOf` requires every branch, so it narrows the names collected so far.
  // Adding these branches would advertise a type that one branch excludes.
  if (Array.isArray(prop.allOf) && prop.allOf.length > 0) {
    for (const variant of prop.allOf) {
      const branchNames = propertyTypeNames(variant, depth + 1);
      if (branchNames === null) return null;
      if (branchNames.length === 0) continue;
      const branch = new Set(branchNames);
      names = names ? intersectTypeNames(names, branch) : branch;
    }
  }

  if (names && names.size === 0) return null;

  // A declared value with no `type` still names its own kind (`const`, `enum`).
  if (!names) {
    const literals = prop.const !== undefined ? [prop.const] : prop.enum;
    if (Array.isArray(literals) && literals.length > 0) {
      const kinds = new Set<string>();
      for (const literal of literals) {
        if (literal === null) continue;
        kinds.add(typeof literal);
      }
      if (kinds.size === 1) {
        const [kind] = kinds;
        if (kind === "string" || kind === "number" || kind === "boolean") {
          return [kind];
        }
      }
    }
  }

  return names ? [...names] : [];
}

/** Runtime value types a single JSON Schema type name can satisfy. */
function runtimeTypeName(name: string): RuntimeParameterType | undefined {
  // `integer` is a narrower `number`; `null` and unknown names are not value types.
  if (name === "integer") return "number";
  return name === "string" ||
    name === "number" ||
    name === "boolean" ||
    name === "object" ||
    name === "array"
    ? name
    : undefined;
}

/**
 * Runtime value types the declared branches allow.
 *
 * Validation uses every name so a value any branch allows is accepted. The
 * advertised schema uses this normalized set, because `integer | number` is one
 * runtime type while `string | number` is two.
 */
function propertyRuntimeTypes(prop: JsonSchemaProperty): RuntimeParameterType[] {
  const types = new Set<RuntimeParameterType>();
  for (const name of propertyTypeNames(prop) ?? []) {
    const type = runtimeTypeName(name);
    if (type) types.add(type);
  }
  return [...types];
}

/**
 * The parameter schema advertised to the model.
 *
 * One runtime type stays a plain `type` (`string | null` → `string`). Distinct
 * runtime types become a pure `anyOf` union: picking the first branch would tell
 * the model that only that branch is valid and would make the declared type
 * depend on branch order.
 *
 * `undefined` means the property accepts no value, so no argument is advertised:
 * any type here would name a value the server schema rejects.
 */
function declaredParameterSchema(prop: JsonSchemaProperty): ActionParameter["schema"] | undefined {
  const names = propertyTypeNames(prop);
  if (names === null) return undefined;
  const types = propertyRuntimeTypes(prop);
  if (types.length === 1) return { type: types[0] };
  if (types.length > 1) return { anyOf: types.map((type) => ({ type })) };
  // No branch names a type. Keep the historical object fallback.
  return { type: "object" };
}

/**
 * The values a property pins to one fixed answer.
 *
 * `const` pins one value. An `anyOf`/`oneOf` whose branches each pin their own
 * value pins the answer just as tightly, so a discriminator written as a union
 * of literals is enforced too. A branch that pins nothing leaves the answer
 * open, and then no list comes back.
 *
 * Core's parameter schema has no `const` field, and `enum` is converted to
 * text, so a numeric `const` cannot be advertised without contradicting its own
 * type. The fixed value is therefore enforced at this validation boundary: an
 * invalid tool call must not reach the MCP server.
 */
function pinnedValues(prop: JsonSchemaProperty | undefined, depth = 0): unknown[] | undefined {
  if (!prop || depth > MAX_TYPE_BRANCH_DEPTH) return undefined;
  if (prop.const !== undefined) return [prop.const];

  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = prop[key];
    if (!Array.isArray(variants) || variants.length === 0) continue;
    const perBranch = variants.map((variant) => pinnedValues(variant, depth + 1));
    // Every branch must pin a value; one open branch makes the union open.
    if (perBranch.every((values) => values !== undefined)) {
      return perBranch.flatMap((values) => values as unknown[]);
    }
  }

  return undefined;
}

/** Readable type names for a description and for validation messages. */
function describeParameterTypes(prop: JsonSchemaProperty): string {
  if (propertyTypeNames(prop) === null) return "no value";
  const types = propertyRuntimeTypes(prop);
  return types.length > 0 ? types.join(" | ") : "object";
}

function formatType(type?: string | string[]): string {
  if (!type) return "";
  if (Array.isArray(type)) {
    return type.join(" | ");
  }
  return type;
}

function isNullable(prop?: JsonSchemaProperty): boolean {
  if (!prop) return false;
  if (prop.nullable === true) return true;
  if (prop.type === "null") return true;
  if (Array.isArray(prop.type) && prop.type.includes("null")) return true;
  if (prop.oneOf?.some((v) => isNullable(v))) return true;
  if (prop.anyOf?.some((v) => isNullable(v))) return true;
  return false;
}

function renderSchemaDetails(prop: JsonSchemaProperty): string {
  const parts: string[] = [];
  if (prop.description) {
    parts.push(prop.description);
  }

  if (prop.enum?.length) {
    parts.push(`Allowed: ${prop.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  }
  if (prop.const !== undefined) {
    parts.push(`Const: ${JSON.stringify(prop.const)}`);
  }
  if (prop.format) {
    parts.push(`Format: ${prop.format}`);
  }

  const bounds: string[] = [];
  if (prop.minimum !== undefined) bounds.push(`min: ${prop.minimum}`);
  if (prop.exclusiveMinimum !== undefined) bounds.push(`exclusiveMin: ${prop.exclusiveMinimum}`);
  if (prop.maximum !== undefined) bounds.push(`max: ${prop.maximum}`);
  if (prop.exclusiveMaximum !== undefined) bounds.push(`exclusiveMax: ${prop.exclusiveMaximum}`);
  if (bounds.length > 0) {
    parts.push(`Range: ${bounds.join(", ")}`);
  }
  if (prop.multipleOf !== undefined) {
    parts.push(`Multiple of: ${prop.multipleOf}`);
  }

  const lengths: string[] = [];
  if (prop.minLength !== undefined) lengths.push(`min: ${prop.minLength}`);
  if (prop.maxLength !== undefined) lengths.push(`max: ${prop.maxLength}`);
  if (lengths.length > 0) {
    parts.push(`Length: ${lengths.join(", ")}`);
  }
  if (prop.pattern) {
    parts.push(`Pattern: ${prop.pattern}`);
  }

  const itemCounts: string[] = [];
  if (prop.minItems !== undefined) itemCounts.push(`min: ${prop.minItems}`);
  if (prop.maxItems !== undefined) itemCounts.push(`max: ${prop.maxItems}`);
  if (itemCounts.length > 0) {
    parts.push(`Item count: ${itemCounts.join(", ")}`);
  }
  if (prop.uniqueItems) {
    parts.push("Unique items: true");
  }
  if (prop.items) {
    if (Array.isArray(prop.items)) {
      const tupleItems = prop.items
        .map((item) => {
          const t = formatType(item.type) || "any";
          const d = renderSchemaDetails(item);
          return d ? `${t} (${d})` : t;
        })
        .join(", ");
      parts.push(`Tuple items: [${tupleItems}]`);
    } else {
      const itemType = formatType(prop.items.type) || "any";
      const itemDetails = renderSchemaDetails(prop.items);
      if (itemDetails) {
        parts.push(`Array of ${itemType} (${itemDetails})`);
      } else {
        parts.push(`Array of ${itemType}`);
      }
    }
  }
  if (prop.contains) {
    const containsDetails = renderSchemaDetails(prop.contains);
    const containsType = formatType(prop.contains.type) || "any";
    parts.push(
      `Contains: ${containsDetails ? `${containsType} (${containsDetails})` : containsType}`
    );
  }

  const propCounts: string[] = [];
  if (prop.minProperties !== undefined) propCounts.push(`min: ${prop.minProperties}`);
  if (prop.maxProperties !== undefined) propCounts.push(`max: ${prop.maxProperties}`);
  if (propCounts.length > 0) {
    parts.push(`Property count: ${propCounts.join(", ")}`);
  }
  if (prop.additionalProperties === false) {
    parts.push("Additional properties: false");
  } else if (typeof prop.additionalProperties === "object" && prop.additionalProperties !== null) {
    const addlType = formatType(prop.additionalProperties.type) || "any";
    const addlDetails = renderSchemaDetails(prop.additionalProperties);
    parts.push(`Additional properties: ${addlDetails ? `${addlType} (${addlDetails})` : addlType}`);
  }
  if (prop.properties && Object.keys(prop.properties).length > 0) {
    const reqSet = new Set(prop.required || []);
    const renderedProps = Object.entries(prop.properties).map(([k, p]) => {
      const isReq = reqSet.has(k);
      const pType = formatType(p.type) || "any";
      const pDetails = renderSchemaDetails(p);
      const reqStr = isReq ? "required" : "optional";
      if (pDetails) {
        return `${k} (${pType}, ${reqStr}): ${pDetails}`;
      }
      return `${k} (${pType}, ${reqStr})`;
    });
    parts.push(`Properties: { ${renderedProps.join("; ")} }`);
  }

  if (prop.$ref) {
    parts.push(`$ref: ${prop.$ref}`);
  }
  if (prop.oneOf?.length) {
    const variants = prop.oneOf.map((v) => {
      const vType = formatType(v.type);
      const vDetails = renderSchemaDetails(v);
      if (vType && vDetails) return `${vType} (${vDetails})`;
      return vDetails || vType || "unknown";
    });
    parts.push(`One of: [${variants.join(" | ")}]`);
  }
  if (prop.anyOf?.length) {
    const variants = prop.anyOf.map((v) => {
      const vType = formatType(v.type);
      const vDetails = renderSchemaDetails(v);
      if (vType && vDetails) return `${vType} (${vDetails})`;
      return vDetails || vType || "unknown";
    });
    parts.push(`Any of: [${variants.join(" | ")}]`);
  }
  if (prop.allOf?.length) {
    const variants = prop.allOf.map((v) => {
      const vType = formatType(v.type);
      const vDetails = renderSchemaDetails(v);
      if (vType && vDetails) return `${vType} (${vDetails})`;
      return vDetails || vType || "unknown";
    });
    parts.push(`All of: [${variants.join(" & ")}]`);
  }
  if (prop.default !== undefined) {
    parts.push(`Default: ${JSON.stringify(prop.default)}`);
  }

  return parts.join(". ");
}

function buildDescription(_name: string, prop: JsonSchemaProperty): string {
  const details = renderSchemaDetails(prop);
  return details.length > 0 ? details : `(${describeParameterTypes(prop)})`;
}

export function convertJsonSchemaToActionParams(
  schema?: McpInputSchema
): ActionParameter[] | undefined {
  const properties = schema?.properties as Record<string, JsonSchemaProperty> | undefined;
  if (!properties || Object.keys(properties).length === 0) return undefined;

  const required = new Set<string>((schema?.required as string[]) || []);
  const params: ActionParameter[] = [];

  for (const [name, prop] of Object.entries(properties)) {
    const declared = declaredParameterSchema(prop);
    // The property accepts no value. It cannot be a valid argument, and any
    // advertised type would name a value the MCP server rejects.
    if (!declared) continue;
    // A pure union carries no sibling constraints: core rejects those, and each
    // branch already states its own type.
    const attachEnum = declared.type !== undefined && prop.enum !== undefined;
    params.push({
      name,
      description: buildDescription(name, prop),
      required: required.has(name),
      schema: {
        ...declared,
        default: declared.type !== undefined ? prop.default : undefined,
        enum: attachEnum ? prop.enum?.map((value) => String(value)) : undefined,
        enumValues: attachEnum ? prop.enum?.map((value) => String(value)) : undefined,
      },
    });
  }

  return params.length > 0 ? params : undefined;
}

export function validateParamsAgainstSchema(
  params: Record<string, unknown>,
  schema?: McpInputSchema
): string[] {
  if (!schema) return [];

  const errors: string[] = [];
  const properties = schema.properties as Record<string, JsonSchemaProperty> | undefined;
  const required = new Set<string>((schema.required as string[]) || []);

  for (const field of required) {
    const val = params[field];
    const prop = properties?.[field];
    if (val === undefined || (val === null && !isNullable(prop))) {
      errors.push(`Missing required parameter: ${field}`);
    }
  }

  if (properties) {
    for (const [name, value] of Object.entries(params)) {
      const prop = properties[name];
      if (!prop) continue;

      // A pinned value is checked before the null shortcut: `const: null` must
      // reject a number just as `const: 1` must reject null.
      const pinned = pinnedValues(prop);
      if (pinned && !pinned.some((candidate) => isDeepStrictEqual(candidate, value))) {
        errors.push(
          `Parameter '${name}' must equal ${pinned.map((candidate) => JSON.stringify(candidate)).join(" or ")}`
        );
        continue;
      }

      if (value === null) {
        continue;
      }
      if (value === undefined) continue;

      const typeNames = propertyTypeNames(prop);
      const actual = getValueType(value);

      // The simultaneous constraints share no type, so the server schema
      // rejects every value. Do not accept a value that one keyword excludes.
      if (typeNames === null) {
        errors.push(`Parameter '${name}' accepts no value, got ${actual}`);
        continue;
      }

      const declaredTypes = typeNames.filter((type) => type !== "null");
      const expected = describeParameterTypes(prop);

      if (declaredTypes.length > 0) {
        const allowedTypes = declaredTypes.map((type) => (type === "integer" ? "number" : type));
        if (!allowedTypes.includes(actual)) {
          errors.push(`Parameter '${name}' expected ${expected}, got ${actual}`);
        }
      } else if (actual !== expected) {
        errors.push(`Parameter '${name}' expected ${expected}, got ${actual}`);
      }

      const requiresInteger =
        declaredTypes.includes("integer") && !declaredTypes.includes("number");
      if (requiresInteger && typeof value === "number" && !Number.isInteger(value)) {
        errors.push(`Parameter '${name}' expected integer, got ${value}`);
      }

      if (prop.enum && !prop.enum.includes(value)) {
        errors.push(
          `Parameter '${name}' must be one of: ${prop.enum.map((v) => JSON.stringify(v)).join(", ")}`
        );
      }
    }
  }

  return errors;
}

function getValueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "object";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}
