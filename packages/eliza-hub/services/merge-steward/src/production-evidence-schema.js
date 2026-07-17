import { readFileSync } from "node:fs";

export const PRODUCTION_EVIDENCE_SCHEMA = deepFreeze(
  JSON.parse(
    readFileSync(
      new URL("../production-evidence.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

export function validateProductionEvidenceShape(
  evidence,
  { schema = PRODUCTION_EVIDENCE_SCHEMA } = {},
) {
  const errors = [];

  validateSchemaValue(evidence, schema, "", errors);

  return {
    ok: errors.length === 0,
    errors,
  };
}

function validateSchemaValue(value, schema, path, errors) {
  const allowedTypes = normalizeTypes(schema.type);
  if (
    allowedTypes.length > 0 &&
    !allowedTypes.some((type) => matchesType(value, type))
  ) {
    errors.push(
      shapeError(
        "invalid_type",
        path,
        `${pathLabel(path)} must be ${allowedTypes.map(typeLabel).join(" or ")}`,
      ),
    );
    return;
  }

  if (schema.enum && value != null && !schema.enum.includes(value)) {
    errors.push(
      shapeError(
        "invalid_enum",
        path,
        `${pathLabel(path)} must be one of: ${schema.enum.join(", ")}`,
      ),
    );
  }

  if (matchesType(value, "object")) {
    validateObject(value, schema, path, errors);
  } else if (matchesType(value, "array")) {
    validateArray(value, schema, path, errors);
  } else if (matchesType(value, "string")) {
    validateString(value, schema, path, errors);
  } else if (matchesType(value, "number")) {
    validateNumber(value, schema, path, errors);
  }
}

function validateObject(value, schema, path, errors) {
  const properties = schema.properties ?? {};

  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) {
      const childPath = joinPath(path, key);
      errors.push(
        shapeError(
          "missing_property",
          childPath,
          `${pathLabel(childPath)} is required`,
        ),
      );
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        const childPath = joinPath(path, key);
        errors.push(
          shapeError(
            "unexpected_property",
            childPath,
            `${pathLabel(childPath)} is not allowed`,
          ),
        );
      }
    }
  }

  for (const [key, childSchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, key)) {
      validateSchemaValue(value[key], childSchema, joinPath(path, key), errors);
    }
  }
}

function validateArray(value, schema, path, errors) {
  if (schema.uniqueItems) {
    const seen = new Set();
    for (const item of value) {
      const key = JSON.stringify(item);
      if (seen.has(key)) {
        errors.push(
          shapeError(
            "duplicate_array_item",
            path,
            `${pathLabel(path)} must not include duplicate items`,
          ),
        );
        break;
      }
      seen.add(key);
    }
  }

  if (schema.items) {
    value.forEach((item, index) => {
      validateSchemaValue(item, schema.items, `${path}[${index}]`, errors);
    });
  }
}

function validateString(value, schema, path, errors) {
  if (schema.minLength != null && value.length < schema.minLength) {
    errors.push(
      shapeError(
        "string_too_short",
        path,
        `${pathLabel(path)} must not be empty`,
      ),
    );
  }

  if (schema.format === "uri") {
    try {
      new URL(value);
    } catch {
      // error-policy:J3 URI parse failure becomes a typed shape error
      errors.push(
        shapeError(
          "invalid_uri",
          path,
          `${pathLabel(path)} must be a valid URI`,
        ),
      );
    }
  } else if (
    schema.format === "date-time" &&
    !Number.isFinite(Date.parse(value))
  ) {
    errors.push(
      shapeError(
        "invalid_date_time",
        path,
        `${pathLabel(path)} must be a valid date-time`,
      ),
    );
  }
}

function validateNumber(value, schema, path, errors) {
  if (schema.minimum != null && value < schema.minimum) {
    errors.push(
      shapeError(
        "number_below_minimum",
        path,
        `${pathLabel(path)} must be at least ${schema.minimum}`,
      ),
    );
  }
}

function normalizeTypes(type) {
  if (!type) return [];
  return Array.isArray(type) ? type : [type];
}

function matchesType(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function typeLabel(type) {
  if (type === "array") return "an array";
  if (type === "object") return "an object";
  if (type === "null") return "null";
  return `a ${type}`;
}

function shapeError(code, path, message) {
  return { code, path: pathLabel(path), message };
}

function pathLabel(path) {
  return path || "$";
}

function joinPath(base, key) {
  return base ? `${base}.${key}` : key;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}
