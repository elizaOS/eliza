/**
 * Serialization utilities
 * Converted from sweagent/utils/serialization.py
 */

import yaml from 'js-yaml';

/**
 * Convert strings to YAML literal strings for better readability
 */
export function convertToYamlLiteralString(data: unknown): unknown {
  if (typeof data === 'string' && data.includes('\n')) {
    // In JS, we can't directly create literal block scalars
    // This is handled by the yaml library based on content
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => convertToYamlLiteralString(item));
  }

  if (data && typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = convertToYamlLiteralString(value);
    }
    return result;
  }

  return data;
}

/**
 * Serialize data to YAML with line breaks preserved
 */
export function yamlSerializationWithLinebreaks(data: unknown): string {
  const processed = convertToYamlLiteralString(data);

  // Use yaml.dump with options to preserve line breaks
  return yaml.dump(processed, {
    lineWidth: -1, // Don't wrap lines
    noRefs: true, // Don't use references
    quotingType: '"', // Use double quotes
    forceQuotes: false, // Only quote when necessary
    styles: {
      '!!str': 'literal', // Use literal style for multiline strings
    },
  });
}

/**
 * Merge nested dictionaries/objects
 */
export function mergeNestedDicts(d1: unknown, d2: unknown): unknown {
  if (!d1) {
    return d2;
  }
  if (!d2) {
    return d1;
  }

  // If either is not an object, return d2 (override)
  if (typeof d1 !== 'object' || typeof d2 !== 'object') {
    return d2;
  }

  // If either is an array, return d2 (override)
  if (Array.isArray(d1) || Array.isArray(d2)) {
    return d2;
  }

  // Merge objects
  const result: Record<string, unknown> = { ...(d1 as Record<string, unknown>) };

  for (const [key, value] of Object.entries(d2)) {
    if (key in result) {
      result[key] = mergeNestedDicts(result[key], value);
    } else {
      result[key] = value;
    }
  }

  return result;
}
