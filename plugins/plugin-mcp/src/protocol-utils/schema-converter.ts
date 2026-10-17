/** Converts MCP JSON Schemas into runtime action parameters without dropping constraints. */
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

function propertyTypeNames(prop: JsonSchemaProperty | undefined, depth = 0): string[] {
  if (!prop || depth > MAX_TYPE_BRANCH_DEPTH) return [];
  const names = new Set<string>();
  if (typeof prop.type === "string") {
    names.add(prop.type);
  } else if (Array.isArray(prop.type)) {
    for (const entry of prop.type) {
      if (typeof entry === "string") names.add(entry);
    }
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = prop[key];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      for (const name of propertyTypeNames(variant, depth + 1)) names.add(name);
    }
  }

  // `allOf` requires every branch. Only a type that all typed branches agree on
  // can describe the value, so intersect the branch sets.
  const allOf = prop.allOf;
  if (Array.isArray(allOf) && allOf.length > 0) {
    let shared: Set<string> | undefined;
    for (const variant of allOf) {
      const branchNames = propertyTypeNames(variant, depth + 1);
      if (branchNames.length === 0) continue;
      shared = shared
        ? new Set([...shared].filter((name) => branchNames.includes(name)))
        : new Set(branchNames);
    }
    if (shared) for (const name of shared) names.add(name);
  }

  // A declared value with no `type` still names its own kind (`const`, `enum`).
  if (names.size === 0) {
    const literals = prop.const !== undefined ? [prop.const] : prop.enum;
    if (Array.isArray(literals) && literals.length > 0) {
      const kinds = new Set<string>();
      for (const literal of literals) {
        if (literal === null) continue;
        kinds.add(typeof literal);
      }
      if (kinds.size === 1) {
        const [kind] = kinds;
        if (kind === "string" || kind === "number" || kind === "boolean") names.add(kind);
      }
    }
  }

  return [...names];
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
  for (const name of propertyTypeNames(prop)) {
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
 */
function declaredParameterSchema(prop: JsonSchemaProperty): ActionParameter["schema"] {
  const types = propertyRuntimeTypes(prop);
  if (types.length === 1) return { type: types[0] };
  if (types.length > 1) return { anyOf: types.map((type) => ({ type })) };
  // No branch names a type. Keep the historical object fallback.
  return { type: "object" };
}

/** Readable type names for a description and for validation messages. */
function describeParameterTypes(prop: JsonSchemaProperty): string {
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

      if (value === null) {
        if (!required.has(name) && !isNullable(prop)) {
          errors.push(`Parameter '${name}' does not accept null`);
        }
        continue;
      }
      if (value === undefined) continue;

      const declaredTypes = propertyTypeNames(prop).filter((type) => type !== "null");
      const expected = describeParameterTypes(prop);
      const actual = getValueType(value);

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
