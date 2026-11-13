/** Converts MCP JSON Schemas into runtime action parameters without dropping constraints. */
import { ElizaError } from "@elizaos/core/protocol";
export interface McpInputSchema {
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

type RuntimeParameterType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";
type Primitive = string | number | boolean | null;
interface ParameterSchema {
  type?: RuntimeParameterType;
  anyOf?: ParameterSchema[];
  oneOf?: ParameterSchema[];
  description?: string;
  default?: unknown;
  enum?: Primitive[];
  enumValues?: Primitive[];
}

/** MCP → runtime action parameter row (replaces removed @elizaos/core ActionParameter export). */
export interface ActionParameter {
  name: string;
  description: string;
  required?: boolean;
  schema: ParameterSchema;
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

const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;
const PIN_KEYS = new Set([
  "type",
  "const",
  "enum",
  ...COMBINATORS,
  "title",
  "description",
  "default",
  "examples",
  "$comment",
]);

function hasPinnedConstraints(prop: JsonSchemaProperty): boolean {
  if (!prop || typeof prop !== "object") return false;
  return (
    prop.const !== undefined ||
    prop.enum !== undefined ||
    COMBINATORS.some((key) => Array.isArray(prop[key]) && prop[key].some(hasPinnedConstraints)) ||
    Object.values(prop.properties ?? {}).some(hasPinnedConstraints) ||
    (Array.isArray(prop.items)
      ? prop.items.some(hasPinnedConstraints)
      : prop.items !== undefined && hasPinnedConstraints(prop.items)) ||
    (typeof prop.additionalProperties === "object" &&
      hasPinnedConstraints(prop.additionalProperties)) ||
    (prop.contains !== undefined && hasPinnedConstraints(prop.contains))
  );
}

function rejectPinnedSchema(path: string, unsupported: boolean): never {
  throw new ElizaError(
    `MCP parameter '${path}' has ${unsupported ? "unsupported pinned constraints" : "no legal pinned values"}`,
    {
      code: unsupported ? "MCP_PINNED_SCHEMA_UNSUPPORTED" : "MCP_PINNED_SCHEMA_UNSATISFIABLE",
      context: { path },
    }
  );
}

function assertSupportedPins(prop: JsonSchemaProperty, path: string): void {
  if (
    !prop ||
    typeof prop !== "object" ||
    Array.isArray(prop) ||
    Object.keys(prop).some((key) => !PIN_KEYS.has(key))
  )
    rejectPinnedSchema(path, true);
  if (
    prop.type !== undefined &&
    ([prop.type].flat().length === 0 ||
      new Set([prop.type].flat()).size !== [prop.type].flat().length ||
      [prop.type]
        .flat()
        .some(
          (type) =>
            !["string", "number", "integer", "boolean", "null", "object", "array"].includes(type)
        ))
  )
    rejectPinnedSchema(path, true);
  if (prop.enum !== undefined && !Array.isArray(prop.enum)) rejectPinnedSchema(path, true);
  const values = [...(prop.const === undefined ? [] : [prop.const]), ...(prop.enum ?? [])];
  if (
    values.some(
      (value) =>
        (value !== null && !["string", "number", "boolean"].includes(typeof value)) ||
        (typeof value === "number" && !Number.isFinite(value))
    )
  )
    rejectPinnedSchema(path, true);
  for (const key of COMBINATORS) {
    if (prop[key] !== undefined && (!Array.isArray(prop[key]) || prop[key].length === 0))
      rejectPinnedSchema(path, true);
    prop[key]?.forEach((branch, index) => {
      assertSupportedPins(branch, `${path}.${key}[${index}]`);
    });
  }
}

function createPinnedMatcher() {
  const enumSets = new WeakMap<JsonSchemaProperty, Set<unknown>>();
  function matches(prop: JsonSchemaProperty, value: unknown): boolean {
    let members = enumSets.get(prop);
    if (prop.enum !== undefined && members === undefined) {
      members = new Set(prop.enum);
      enumSets.set(prop, members);
    }
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    return (
      (prop.type === undefined ||
        [prop.type]
          .flat()
          .some(
            (name) =>
              name === type ||
              (name === "integer" && typeof value === "number" && Number.isInteger(value))
          )) &&
      (prop.const === undefined || prop.const === value) &&
      (members === undefined || members.has(value)) &&
      (prop.anyOf === undefined || prop.anyOf.some((branch) => matches(branch, value))) &&
      (prop.oneOf === undefined ||
        prop.oneOf.filter((branch) => matches(branch, value)).length === 1) &&
      (prop.allOf === undefined || prop.allOf.every((branch) => matches(branch, value)))
    );
  }
  return matches;
}

/** A finite superset; the complete simultaneous constraints filter it below. */
function pinnedCandidates(prop: JsonSchemaProperty): Primitive[] | undefined {
  if (prop.const !== undefined) return [prop.const as Primitive];
  if (prop.enum !== undefined) return prop.enum as Primitive[];
  const types = prop.type === undefined ? [] : [prop.type].flat();
  if (types.length > 0 && types.every((type) => type === "null" || type === "boolean")) {
    return types.flatMap<Primitive>((type) => (type === "null" ? [null] : [false, true]));
  }
  const intersection = prop.allOf?.map(pinnedCandidates).find((values) => values !== undefined);
  if (intersection !== undefined) return intersection;
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = prop[key]?.map(pinnedCandidates);
    if (branches?.every((values) => values !== undefined)) return branches.flat();
  }
  return undefined;
}

function projectPinnedSchema(prop: JsonSchemaProperty, path: string): ParameterSchema {
  assertSupportedPins(prop, path);
  const matches = createPinnedMatcher();
  function project(part: JsonSchemaProperty): ParameterSchema | null {
    const candidates = pinnedCandidates(part);
    if (candidates !== undefined) {
      const groups = new Map<RuntimeParameterType, Primitive[]>();
      for (const value of new Set(candidates)) {
        if (!matches(part, value)) continue;
        const type = (value === null ? "null" : typeof value) as RuntimeParameterType;
        const group = groups.get(type);
        if (group) group.push(value);
        else groups.set(type, [value]);
      }
      const branches = [...groups].map(([type, values]) => ({
        type,
        enum: values,
        enumValues: values,
      }));
      return branches.length === 0
        ? null
        : branches.length === 1
          ? { ...branches[0], default: part.default }
          : { anyOf: branches };
    }
    // Open primitive branches retain their exact union structure. Core cannot
    // faithfully represent arbitrary open objects/arrays or untyped leaves.
    if (part.allOf) rejectPinnedSchema(path, true);
    const unions: ParameterSchema = {};
    for (const key of ["anyOf", "oneOf"] as const) {
      if (part[key]) {
        const branches = part[key]
          .map(project)
          .filter((branch): branch is ParameterSchema => branch !== null);
        if (branches.length === 0) return null;
        unions[key] = branches;
      }
    }
    if (part.type !== undefined) {
      const types = [part.type].flat();
      if (types.some((type) => type === "object" || type === "array"))
        rejectPinnedSchema(path, true);
      const branches = types.map((type) => ({
        ...unions,
        type: type as RuntimeParameterType,
        default: part.default,
      }));
      return branches.length === 1 ? branches[0] : { anyOf: branches };
    }
    if (unions.anyOf || unions.oneOf) return unions;
    return rejectPinnedSchema(path, true);
  }
  return project(prop) ?? rejectPinnedSchema(path, false);
}

function propertyRuntimeTypes(prop: JsonSchemaProperty): RuntimeParameterType[] {
  const branches = prop.anyOf ?? prop.oneOf;
  const names =
    prop.type !== undefined
      ? [prop.type].flat()
      : branches?.length && branches.every((branch) => branch.type !== undefined)
        ? branches.flatMap((branch) => [branch.type as string | string[]].flat())
        : [];
  const types = new Set(names.filter((name) => name !== "null").map(mapJsonSchemaType));
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
    const pinnedSchema = hasPinnedConstraints(prop) ? projectPinnedSchema(prop, name) : undefined;
    const types = pinnedSchema ? [] : propertyRuntimeTypes(prop);
    params.push({
      name,
      description: buildDescription(name, prop),
      required: required.has(name),
      // Pinned constraints must survive core's model-facing projection exactly.
      schema:
        pinnedSchema ??
        (types.length === 1
          ? {
              type: types[0],
              default: prop.default,
            }
          : { anyOf: types.map((type) => ({ type })) }),
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
  const pinnedMatchers = new Map<string, ReturnType<typeof createPinnedMatcher>>();
  for (const [name, prop] of Object.entries(properties ?? {})) {
    if (hasPinnedConstraints(prop)) {
      projectPinnedSchema(prop, name);
      pinnedMatchers.set(name, createPinnedMatcher());
    }
  }

  for (const field of required) {
    const val = params[field];
    const prop = properties?.[field];
    const matches = pinnedMatchers.get(field);
    if (
      val === undefined ||
      (val === null && !(matches && prop ? matches(prop, null) : isNullable(prop)))
    ) {
      errors.push(`Missing required parameter: ${field}`);
    }
  }

  if (properties) {
    for (const [name, value] of Object.entries(params)) {
      const prop = properties[name];
      if (!prop) continue;

      const matches = pinnedMatchers.get(name);
      if (matches) {
        if (value !== undefined && !matches(prop, value)) {
          if (value === null) {
            if (!required.has(name)) errors.push(`Parameter '${name}' does not accept null`);
          } else {
            const values = pinnedCandidates(prop)?.filter((candidate) => matches(prop, candidate));
            errors.push(
              prop.oneOf && prop.oneOf.filter((branch) => matches(branch, value)).length > 1
                ? `Parameter '${name}' matches more than one branch of the oneOf`
                : values?.length === 1
                  ? `Parameter '${name}' must be ${JSON.stringify(values[0])}`
                  : values
                    ? `Parameter '${name}' must be one of: ${values.map((candidate) => JSON.stringify(candidate)).join(", ")}`
                    : `Parameter '${name}' does not satisfy its const/enum constraints`
            );
          }
        }
        continue;
      }

      if (value === null) {
        if (!required.has(name) && !isNullable(prop)) {
          errors.push(`Parameter '${name}' does not accept null`);
        }
        continue;
      }
      if (value === undefined) continue;

      const allowedTypes = propertyRuntimeTypes(prop);
      const actual = getValueType(value);
      if (!allowedTypes.includes(actual as RuntimeParameterType)) {
        errors.push(`Parameter '${name}' expected ${allowedTypes.join(" | ")}, got ${actual}`);
      }

      const requiresInteger = Array.isArray(prop.type)
        ? prop.type.includes("integer") && !prop.type.includes("number")
        : prop.type === "integer";
      if (requiresInteger && typeof value === "number" && !Number.isInteger(value)) {
        errors.push(`Parameter '${name}' expected integer, got ${value}`);
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
