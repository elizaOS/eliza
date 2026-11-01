/** Converts MCP JSON Schemas into runtime action parameters without dropping constraints. */
export interface McpInputSchema {
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

type RuntimeParameterType = "string" | "number" | "boolean" | "object" | "array";

/** MCP → runtime action parameter row (replaces removed @elizaos/core ActionParameter export). */
export interface ActionParameter {
  name: string;
  description: string;
  required?: boolean;
  schema: {
    /** Absent for a union of several runtime types, which `anyOf` states. */
    type?: RuntimeParameterType;
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

function mapJsonSchemaType(jsonType: string): RuntimeParameterType {
  switch (jsonType) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    default:
      return "object";
  }
}

function valueRuntimeType(value: unknown): RuntimeParameterType {
  if (Array.isArray(value)) return "array";
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

/**
 * Every value a property pins with `const`/`enum`, on the property itself or
 * on its `anyOf`/`oneOf` branches. Used to read the runtime kind of a property
 * that names no `type`: pydantic emits `{"const": "fast"}` for a single-value
 * Literal and FastMCP unions carry branch `const`/`enum` sets.
 */
function declaredPinnedValues(prop: JsonSchemaProperty): unknown[] {
  const values: unknown[] = [];
  if (prop.const !== undefined) values.push(prop.const);
  if (prop.enum?.length) values.push(...prop.enum);
  for (const branch of prop.anyOf ?? prop.oneOf ?? []) {
    if (branch.const !== undefined) values.push(branch.const);
    if (branch.enum?.length) values.push(...branch.enum);
  }
  return values;
}

/**
 * The value set a call must match: a top-level `const`, or a union whose every
 * branch pins its own values with `const`/`enum` (a `null` branch pins null).
 * Returns undefined when any branch stays open, because then the union accepts
 * more than the pinned values.
 */
function enforcedPinnedValues(prop: JsonSchemaProperty): unknown[] | undefined {
  if (prop.const !== undefined) return [prop.const];
  const branches = prop.anyOf ?? prop.oneOf;
  if (!branches?.length) return undefined;
  const values: unknown[] = [];
  for (const branch of branches) {
    if (branch.const !== undefined) {
      values.push(branch.const);
    } else if (branch.enum?.length) {
      values.push(...branch.enum);
    } else if (branch.type === "null") {
      values.push(null);
    } else {
      return undefined;
    }
  }
  return values;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  if (aKeys.length !== Object.keys(bRecord).length) return false;
  return aKeys.every((key) => deepEqual(aRecord[key], bRecord[key]));
}

/**
 * Runtime types a property accepts. A property with no `type` takes the types
 * of its `anyOf`/`oneOf` branches: FastMCP emits
 * `{"anyOf":[{"type":"string"},{"type":"null"}]}` for `Optional[str]`. A
 * property that names no type anywhere still pins its values with
 * `const`/`enum` (pydantic emits `{"const": "fast"}` for a single-value
 * Literal), so the kind comes from the pinned values. An untyped branch with
 * no pinned values, or no constraint at all, keeps the `object` fallback.
 */
function propertyRuntimeTypes(prop: JsonSchemaProperty): RuntimeParameterType[] {
  const branches = prop.anyOf ?? prop.oneOf;
  const names =
    prop.type !== undefined
      ? [prop.type].flat()
      : branches?.length && branches.every((branch) => branch.type !== undefined)
        ? branches.flatMap((branch) => [branch.type as string | string[]].flat())
        : [];
  const types = new Set(names.filter((name) => name !== "null").map(mapJsonSchemaType));
  if (types.size === 0) {
    for (const value of declaredPinnedValues(prop)) {
      if (value !== null) types.add(valueRuntimeType(value));
    }
  }
  return types.size > 0 ? [...types] : ["object"];
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
  const explicitlyNullable = prop.nullable === true;

  if (prop.type !== undefined) {
    if (Array.isArray(prop.type)) {
      if (!prop.type.includes("null")) return false;
    } else if (prop.type !== "null" && !explicitlyNullable) {
      return false;
    }
  }

  if (prop.enum && !prop.enum.some((value) => value === null)) return false;
  if (prop.const !== undefined && prop.const !== null) return false;
  if (prop.allOf && !prop.allOf.every((v) => isNullable(v))) return false;
  // oneOf requires exactly one branch to match, so null is acceptable only
  // when exactly one branch accepts it; two nullable branches make null
  // ambiguous and must be rejected.
  if (prop.oneOf && prop.oneOf.filter((v) => isNullable(v)).length !== 1) return false;
  if (prop.anyOf && !prop.anyOf.some((v) => isNullable(v))) return false;
  return true;
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
  return details.length > 0 ? details : `(${propertyRuntimeTypes(prop).join(" | ")})`;
}

export function convertJsonSchemaToActionParams(
  schema?: McpInputSchema
): ActionParameter[] | undefined {
  const properties = schema?.properties as Record<string, JsonSchemaProperty> | undefined;
  if (!properties || Object.keys(properties).length === 0) return undefined;

  const required = new Set<string>((schema?.required as string[]) || []);
  const params: ActionParameter[] = [];

  for (const [name, prop] of Object.entries(properties)) {
    const types = propertyRuntimeTypes(prop);
    params.push({
      name,
      description: buildDescription(name, prop),
      required: required.has(name),
      // Core rejects constraints beside an untyped `anyOf`; the description keeps them.
      schema:
        types.length === 1
          ? {
              type: types[0],
              default: prop.default,
              enum: prop.enum?.map((value) => String(value)),
              enumValues: prop.enum?.map((value) => String(value)),
            }
          : { anyOf: types.map((type) => ({ type })) },
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

      if (value === null) {
        if (!required.has(name) && !isNullable(prop)) {
          errors.push(`Parameter '${name}' does not accept null`);
        }
        continue;
      }
      if (value === undefined) continue;

      const pinned = enforcedPinnedValues(prop);
      const pinnedFailed =
        pinned !== undefined && !pinned.some((candidate) => deepEqual(candidate, value));

      const allowedTypes = propertyRuntimeTypes(prop);
      const actual = getValueType(value);
      if (!pinnedFailed && !allowedTypes.includes(actual as RuntimeParameterType)) {
        errors.push(`Parameter '${name}' expected ${allowedTypes.join(" | ")}, got ${actual}`);
      }

      const requiresInteger = Array.isArray(prop.type)
        ? prop.type.includes("integer") && !prop.type.includes("number")
        : prop.type === "integer";
      if (
        !pinnedFailed &&
        requiresInteger &&
        typeof value === "number" &&
        !Number.isInteger(value)
      ) {
        errors.push(`Parameter '${name}' expected integer, got ${value}`);
      }

      if (pinnedFailed && pinned) {
        errors.push(
          pinned.length === 1
            ? `Parameter '${name}' must be ${JSON.stringify(pinned[0])}`
            : `Parameter '${name}' must be one of: ${pinned.map((v) => JSON.stringify(v)).join(", ")}`
        );
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
