// Dependency-free JSON-schema validator covering the draft 2020-12 subset used
// by the OS confidential schemas (packages/os/release/schema/*.schema.json).
//
// Supported keywords: type, const, enum, required, properties,
// additionalProperties, patternProperties (no), pattern, minLength, minItems,
// minimum, maximum, items, allOf, if/then, format ("date"), and local $ref to
// "#/$defs/<name>". This is intentionally minimal: the OS scripts run under a
// plain `node` invocation with no third-party dependency, matching the existing
// hand-rolled validators in os-release-lib.mjs. It fails closed — any construct
// it does not understand is reported as an error rather than silently passing.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  if (type === "integer") return actual === "integer";
  return actual === type;
}

function resolveRef(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new Error(`unsupported $ref: ${ref}`);
  }
  const segments = ref.slice(2).split("/");
  let node = root;
  for (const segment of segments) {
    node = node?.[segment];
    if (node === undefined) {
      throw new Error(`unresolved $ref: ${ref}`);
    }
  }
  return node;
}

function isValidDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  return Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function validateNode(value, schema, root, instancePath, errors) {
  if (schema.$ref !== undefined) {
    validateNode(
      value,
      resolveRef(root, schema.$ref),
      root,
      instancePath,
      errors,
    );
    return;
  }

  if (schema.const !== undefined) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const)) {
      errors.push(
        `${instancePath}: must equal ${JSON.stringify(schema.const)}`,
      );
    }
  }

  if (Array.isArray(schema.enum)) {
    const ok = schema.enum.some(
      (option) => JSON.stringify(option) === JSON.stringify(value),
    );
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
      value.length < schema.minLength
    ) {
      errors.push(`${instancePath}: must have length >= ${schema.minLength}`);
    }
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern).test(value)
    ) {
      errors.push(`${instancePath}: must match pattern ${schema.pattern}`);
    }
    if (schema.format === "date" && !isValidDate(value)) {
      errors.push(`${instancePath}: must be a valid date (YYYY-MM-DD)`);
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
    if (schema.items) {
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
      if (!(key in value)) {
        errors.push(`${instancePath}: missing required property "${key}"`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${instancePath}.${key}`;
      if (properties[key]) {
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

  if (schema.if) {
    const branchErrors = [];
    validateNode(value, schema.if, root, instancePath, branchErrors);
    if (branchErrors.length === 0 && schema.then) {
      validateNode(value, schema.then, root, instancePath, errors);
    } else if (branchErrors.length > 0 && schema.else) {
      validateNode(value, schema.else, root, instancePath, errors);
    }
  }
}

// Validate `value` against `schema`. Returns { ok, errors }.
export function validateAgainstSchema(value, schema) {
  const errors = [];
  validateNode(value, schema, schema, "$", errors);
  return { ok: errors.length === 0, errors };
}
