// Dependency-free release-schema subset. Schema vocabulary is checked before
// instance validation, including branches not selected by this instance.
import { isDeepStrictEqual } from "node:util";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, type) {
  if (typeof value === "number" && !Number.isFinite(value)) return false;
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  if (type === "integer") return actual === "integer";
  return actual === type;
}

function resolveRef(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new Error(`unsupported $ref: ${ref}`);
  }
  const segments = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node = root;
  for (const segment of segments) {
    node = node && Object.hasOwn(node, segment) ? node[segment] : undefined;
    if (node === undefined) {
      throw new Error(`unresolved $ref: ${ref}`);
    }
  }
  return node;
}

function isValidDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function isValidDateTime(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    isValidDate(value.slice(0, 10)) &&
    Number.isFinite(Date.parse(value))
  );
}

function isValidUri(value) {
  if (typeof value !== "string") return false;
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

function validateNode(value, schema, root, instancePath, errors) {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${instancePath}: rejected by false schema`);
    return;
  }
  if (schema.$ref !== undefined) {
    validateNode(
      value,
      resolveRef(root, schema.$ref),
      root,
      instancePath,
      errors,
    );
  }

  if (schema.const !== undefined) {
    if (!isDeepStrictEqual(value, schema.const)) {
      errors.push(
        `${instancePath}: must equal ${JSON.stringify(schema.const)}`,
      );
    }
  }

  if (Array.isArray(schema.enum)) {
    const ok = schema.enum.some((option) => isDeepStrictEqual(option, value));
    if (!ok) {
      errors.push(
        `${instancePath}: must be one of ${JSON.stringify(schema.enum)}`,
      );
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(
        `${instancePath}: must be of type ${types.join("|")}, got ${typeOf(value)}`,
      );
      // Stop deep validation on type mismatch to avoid noisy cascade errors.
      return;
    }
  }

  const valueType = typeOf(value);

  if (valueType === "string") {
    if (
      typeof schema.minLength === "number" &&
      Array.from(value).length < schema.minLength
    ) {
      errors.push(`${instancePath}: must have length >= ${schema.minLength}`);
    }
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern).test(value)
    ) {
      errors.push(`${instancePath}: must match pattern ${schema.pattern}`);
    }
    if (schema.format !== undefined) {
      if (schema.format === "date" && !isValidDate(value)) {
        errors.push(`${instancePath}: must be a valid date (YYYY-MM-DD)`);
      } else if (schema.format === "date-time" && !isValidDateTime(value)) {
        errors.push(`${instancePath}: must be a valid RFC 3339 date-time`);
      } else if (schema.format === "uri" && !isValidUri(value)) {
        errors.push(`${instancePath}: must be an absolute URI`);
      } else if (!["date", "date-time", "uri"].includes(schema.format)) {
        errors.push(
          `${instancePath}: schema uses unsupported format ${schema.format}`,
        );
      }
    }
  }

  if (valueType === "number" || valueType === "integer") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${instancePath}: must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${instancePath}: must be <= ${schema.maximum}`);
    }
  }

  if (valueType === "array") {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(
        `${instancePath}: must have at least ${schema.minItems} items`,
      );
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        validateNode(
          item,
          schema.items,
          root,
          `${instancePath}[${index}]`,
          errors,
        );
      });
    }
  }

  if (valueType === "object") {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        errors.push(`${instancePath}: missing required property "${key}"`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${instancePath}.${key}`;
      if (Object.hasOwn(properties, key)) {
        validateNode(child, properties[key], root, childPath, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${childPath}: additional property not allowed`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        validateNode(
          child,
          schema.additionalProperties,
          root,
          childPath,
          errors,
        );
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      validateNode(value, sub, root, instancePath, errors);
    }
  }

  if (schema.if !== undefined) {
    const branchErrors = [];
    validateNode(value, schema.if, root, instancePath, branchErrors);
    if (branchErrors.length === 0 && schema.then !== undefined) {
      validateNode(value, schema.then, root, instancePath, errors);
    } else if (branchErrors.length > 0 && schema.else !== undefined) {
      validateNode(value, schema.else, root, instancePath, errors);
    }
  }
}

const keywords = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "pattern",
  "minLength",
  "minItems",
  "minimum",
  "maximum",
  "items",
  "allOf",
  "if",
  "then",
  "else",
  "format",
]);
const types = new Set([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "integer",
  "string",
]);
function checkSchema(schema, root, ancestors = new Set()) {
  if (typeof schema === "boolean") return;
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new Error("schema must be an object or boolean");
  if (ancestors.has(schema))
    throw new Error("recursive release schemas are unsupported");
  const next = new Set(ancestors).add(schema);
  for (const key of Object.keys(schema)) {
    if (!keywords.has(key))
      throw new Error(`unsupported schema keyword: ${key}`);
  }
  if (
    schema.$schema !== undefined &&
    schema.$schema !== "https://json-schema.org/draft/2020-12/schema"
  )
    throw new Error("unsupported schema dialect");
  if (schema.type !== undefined) {
    const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!declared.length || declared.some((type) => !types.has(type)))
      throw new Error("invalid schema type");
  }
  for (const key of ["minimum", "maximum", "minLength", "minItems"]) {
    if (
      schema[key] !== undefined &&
      (!Number.isFinite(schema[key]) ||
        (key.startsWith("min") &&
          key !== "minimum" &&
          (!Number.isInteger(schema[key]) || schema[key] < 0)))
    )
      throw new Error(`invalid ${key}`);
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      schema.required.some((key) => typeof key !== "string"))
  )
    throw new Error("invalid required properties");
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || !schema.enum.length)
  )
    throw new Error("invalid enum");
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") throw new Error("invalid pattern");
    new RegExp(schema.pattern);
  }
  if (
    schema.format !== undefined &&
    !["date", "date-time", "uri"].includes(schema.format)
  )
    throw new Error(`unsupported format: ${schema.format}`);
  for (const key of ["properties", "$defs"]) {
    if (schema[key] !== undefined) {
      if (
        !schema[key] ||
        typeof schema[key] !== "object" ||
        Array.isArray(schema[key])
      )
        throw new Error(`invalid ${key}`);
      for (const child of Object.values(schema[key]))
        checkSchema(child, root, next);
    }
  }
  for (const key of ["items", "additionalProperties", "if", "then", "else"]) {
    if (schema[key] !== undefined) checkSchema(schema[key], root, next);
  }
  if (schema.allOf !== undefined) {
    if (!Array.isArray(schema.allOf) || !schema.allOf.length)
      throw new Error("invalid allOf");
    for (const child of schema.allOf) checkSchema(child, root, next);
  }
  if (schema.$ref !== undefined)
    checkSchema(resolveRef(root, schema.$ref), root, next);
}

// Invalid or unsupported schemas are validation failures, never successful no-ops.
export function validateAgainstSchema(value, schema) {
  const errors = [];
  try {
    checkSchema(schema, schema);
    validateNode(value, schema, schema, "$", errors);
  } catch (error) {
    errors.push(`schema: ${error.message}`);
  }
  return { ok: errors.length === 0, errors };
}
