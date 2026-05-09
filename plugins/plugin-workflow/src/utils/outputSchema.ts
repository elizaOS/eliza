/**
 * Output schema utilities for validating expressions between nodes.
 * Uses pre-crawled schemaIndex.json with full schema content.
 */

import schemaIndex from '../data/schemaIndex.json' with { type: 'json' };
import triggerSchemaIndex from '../data/triggerSchemaIndex.json' with { type: 'json' };
import type { ExpressionRef, SchemaContent } from '../types/index';

type SchemasByResource = Record<string, Record<string, SchemaContent>>;

interface SchemaEntry {
  folder: string;
  schemas: SchemasByResource;
}

interface SchemaIndex {
  nodeTypes: Record<string, SchemaEntry>;
  generatedAt: string;
  version: string;
}

const SCHEMA_INDEX = schemaIndex as unknown as SchemaIndex;
const TRIGGER_SCHEMAS =
  (
    triggerSchemaIndex as unknown as {
      triggers: Record<string, { outputSchema: SchemaContent }>;
    }
  ).triggers ?? {};

const NODE_SCHEMAS = SCHEMA_INDEX.nodeTypes ?? {};

export interface OutputSchemaResult {
  schema: SchemaContent;
  fields: string[];
}

export function hasOutputSchema(nodeType: string): boolean {
  return nodeType in NODE_SCHEMAS;
}

export function getAvailableResources(nodeType: string): string[] {
  const entry = NODE_SCHEMAS[nodeType];
  if (!entry) {
    return [];
  }
  return Object.keys(entry.schemas);
}

export function getAvailableOperations(nodeType: string, resource: string): string[] {
  const entry = NODE_SCHEMAS[nodeType];
  if (!entry) {
    return [];
  }
  const resourceSchemas = entry.schemas[resource];
  if (!resourceSchemas) {
    return [];
  }
  return Object.keys(resourceSchemas);
}

export function loadOutputSchema(
  nodeType: string,
  resource: string,
  operation: string
): OutputSchemaResult | null {
  const entry = NODE_SCHEMAS[nodeType];
  if (!entry) {
    return null;
  }

  const resourceSchemas = entry.schemas[resource];
  if (!resourceSchemas) {
    return null;
  }

  const schema = resourceSchemas[operation];
  if (!schema) {
    return null;
  }

  return {
    schema,
    fields: getTopLevelFields(schema),
  };
}

export function loadTriggerOutputSchema(
  nodeType: string,
  parameters?: Record<string, unknown>
): OutputSchemaResult | null {
  if (parameters?.simple === false) {
    return null;
  }
  const entry = TRIGGER_SCHEMAS[nodeType];
  if (!entry?.outputSchema?.properties || Object.keys(entry.outputSchema.properties).length === 0) {
    return null;
  }
  return {
    schema: entry.outputSchema,
    fields: getTopLevelFields(entry.outputSchema),
  };
}

export function getTopLevelFields(schema: SchemaContent): string[] {
  if (!schema.properties) {
    return [];
  }
  return Object.keys(schema.properties);
}

/** Returns all field paths including nested (e.g., "from.value[0].address") */
export function getAllFieldPaths(schema: SchemaContent, prefix = ''): string[] {
  return getAllFieldPathsTyped(schema, prefix).map((f) => f.path);
}

/** Returns field paths with their types (e.g., "snippet: string", "payload: object"). */
export function getAllFieldPathsTyped(
  schema: SchemaContent,
  prefix = ''
): { path: string; type: string }[] {
  const fields: { path: string; type: string }[] = [];
  const properties = schema.properties;

  if (!properties) {
    return fields;
  }

  for (const [key, value] of Object.entries(properties)) {
    const currentPath = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'object' && value !== null) {
      const propSchema = value as SchemaContent;
      fields.push({ path: currentPath, type: propSchema.type || 'unknown' });

      if (propSchema.type === 'object' && propSchema.properties) {
        fields.push(...getAllFieldPathsTyped(propSchema, currentPath));
      }

      if (propSchema.type === 'array' && propSchema.items) {
        const items = propSchema.items as SchemaContent;
        if (items.type === 'object' && items.properties) {
          fields.push(...getAllFieldPathsTyped(items, `${currentPath}[0]`));
        }
      }
    }
  }

  return fields;
}

export function parseExpressions(
  parameters: Record<string, unknown>,
  parentPath = ''
): ExpressionRef[] {
  const refs: ExpressionRef[] = [];

  for (const [key, value] of Object.entries(parameters)) {
    const currentPath = parentPath ? `${parentPath}.${key}` : key;

    if (typeof value === 'string') {
      refs.push(...extractExpressionsFromString(value, currentPath));
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === 'string') {
          refs.push(...extractExpressionsFromString(value[i], `${currentPath}[${i}]`));
        } else if (typeof value[i] === 'object' && value[i] !== null) {
          refs.push(
            ...parseExpressions(value[i] as Record<string, unknown>, `${currentPath}[${i}]`)
          );
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      refs.push(...parseExpressions(value as Record<string, unknown>, currentPath));
    }
  }

  return refs;
}

function extractExpressionsFromString(str: string, paramPath: string): ExpressionRef[] {
  const refs: ExpressionRef[] = [];

  // Match every $json.field reference, even inside compound expressions like {{ $json.a || $json.b }}
  const simplePattern = /\$json\.([a-zA-Z0-9_.[\]'"-]{1,200})/g;
  // Bracket-notation variant: $json["someField"] or $json['someField'] (Session 21
  // follow-up). The LLM occasionally emits this when the field name has chars
  // that wouldn't survive dot notation, OR when it's just "trying to be safe".
  // Without this pattern, validateAndRepair walks past references like
  // {{ $json["concatenate_subject"] }} silently — the typo never gets caught.
  const bracketPattern = /\$json\[\s*(['"])([^'"]{1,200})\1\s*\]/g;
  const namedNodePattern =
    /\$\(['"]([^'"]{1,100})['"]\)\.item\.json\.([a-zA-Z0-9_.[\]'"-]{1,200})/g;

  let match;

  while ((match = simplePattern.exec(str)) !== null) {
    const field = match[1];
    refs.push({
      fullExpression: match[0],
      field,
      path: parseFieldPath(field),
      paramPath,
    });
  }

  while ((match = bracketPattern.exec(str)) !== null) {
    const field = match[2];
    refs.push({
      fullExpression: match[0],
      field,
      path: parseFieldPath(field),
      paramPath,
    });
  }

  while ((match = namedNodePattern.exec(str)) !== null) {
    const field = match[2];
    refs.push({
      fullExpression: match[0],
      field,
      path: parseFieldPath(field),
      paramPath,
      sourceNodeName: match[1],
    });
  }

  return refs;
}

/**
 * Parses "from.value[0].address" or "headers['content-type']" into path segments.
 */
function parseFieldPath(field: string): string[] {
  const path: string[] = [];
  let current = '';
  let i = 0;

  while (i < field.length) {
    const char = field[i];

    if (char === '.') {
      if (current) {
        path.push(current);
        current = '';
      }
      i++;
    } else if (char === '[') {
      if (current) {
        path.push(current);
        current = '';
      }
      i++;
      if (i >= field.length) {
        break;
      }
      if (field[i] === "'" || field[i] === '"') {
        const quote = field[i];
        i++;
        while (i < field.length && field[i] !== quote) {
          current += field[i];
          i++;
        }
        i++;
      } else {
        while (i < field.length && field[i] !== ']') {
          current += field[i];
          i++;
        }
      }
      if (current) {
        path.push(current);
        current = '';
      }
      i++;
    } else {
      current += char;
      i++;
    }
  }

  if (current) {
    path.push(current);
  }

  return path;
}

export function fieldExistsInSchema(path: string[], schema: SchemaContent): boolean {
  if (path.length === 0) {
    return false;
  }

  let current: SchemaContent | undefined = schema;

  for (let i = 0; i < path.length; i++) {
    const segment = path[i];

    if (!current || typeof current !== 'object') {
      return false;
    }

    const properties = current.properties;
    if (!properties) {
      return false;
    }

    const prop = properties[segment] as SchemaContent | undefined;
    if (!prop) {
      return false;
    }

    if (i === path.length - 1) {
      return true;
    }

    if (prop.type === 'object') {
      current = prop;
    } else if (prop.type === 'array' && prop.items) {
      const nextSegment = path[i + 1];
      if (/^\d+$/.test(nextSegment)) {
        i++;
        current = prop.items as SchemaContent;
      } else {
        return false;
      }
    } else {
      return false;
    }
  }

  return false;
}

export function formatSchemaForPrompt(schema: SchemaContent, maxDepth = 2): string {
  const lines: string[] = [];

  function format(obj: SchemaContent, depth: number, prefix: string) {
    const properties = obj.properties;
    if (!properties || depth > maxDepth) {
      return;
    }

    for (const [key, value] of Object.entries(properties)) {
      const prop = value as SchemaContent;
      const type = prop.type as string;
      const path = prefix ? `${prefix}.${key}` : key;

      if (type === 'object' && prop.properties) {
        lines.push(`${path}: object`);
        format(prop, depth + 1, path);
      } else if (type === 'array' && prop.items) {
        const items = prop.items as SchemaContent;
        if (items.type === 'object' && items.properties) {
          lines.push(`${path}: array of objects`);
          format(items, depth + 1, `${path}[0]`);
        } else {
          lines.push(`${path}: array of ${items.type || 'unknown'}`);
        }
      } else {
        lines.push(`${path}: ${type || 'unknown'}`);
      }
    }
  }

  format(schema, 0, '');
  return lines.join('\n');
}
