/**
 * Simple YAML parser for basic YAML structures
 * Handles the YAML formats used in SWE-agent without external dependencies
 */

// Type for parsed YAML data
export type YamlData = string | number | boolean | null | YamlData[] | { [key: string]: YamlData };

/**
 * Parse a simple YAML string
 */
export function parseYAML(yamlString: string): YamlData {
  const lines = yamlString.split('\n');
  const result: Record<string, YamlData> = {};
  const stack: Array<Record<string, YamlData> | YamlData[]> = [result];
  const indentStack: number[] = [0];
  let currentList: YamlData[] | null = null;
  let currentListIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Skip empty lines and comments
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    // Calculate indentation
    const indent = line.length - line.trimStart().length;

    // Handle list items
    if (trimmedLine.startsWith('- ')) {
      const value = trimmedLine.substring(2).trim();

      // Pop stack to appropriate level
      while (indentStack.length > 1 && indent <= indentStack[indentStack.length - 1]) {
        stack.pop();
        indentStack.pop();
        if (currentListIndent >= indentStack[indentStack.length - 1]) {
          currentList = null;
          currentListIndent = -1;
        }
      }

      // Create or continue list
      if (!currentList || indent !== currentListIndent) {
        currentList = [];
        currentListIndent = indent;

        // Find the key for this list
        const parent = stack[stack.length - 1];
        const lastKey = Object.keys(parent).pop();
        if (lastKey && !Array.isArray(parent) && parent[lastKey] === null) {
          parent[lastKey] = currentList;
        } else {
          // Standalone list
          if (!Array.isArray(parent)) {
            parent['items'] = currentList;
          }
        }
      }

      // Parse the list item value
      if (value.includes(': ')) {
        // List item is an object
        const obj = parseKeyValue(value);
        currentList.push(obj);
      } else {
        // Simple value
        currentList.push(parseValue(value));
      }
    } else if (trimmedLine.includes(': ')) {
      // Handle key-value pairs
      const colonIndex = trimmedLine.indexOf(': ');
      const key = trimmedLine.substring(0, colonIndex).trim();
      const value = trimmedLine.substring(colonIndex + 2).trim();

      // Pop stack to appropriate level
      while (indentStack.length > 1 && indent < indentStack[indentStack.length - 1]) {
        stack.pop();
        indentStack.pop();
      }

      const parent = stack[stack.length - 1];

      if (!value || value === '|' || value === '>') {
        // Multi-line string or nested object
        if (value === '|' || value === '>') {
          // Multi-line string
          const multilineValue = parseMultilineString(lines, i + 1, indent + 2);
          if (!Array.isArray(parent)) {
            parent[key] = multilineValue.value;
          }
          i = multilineValue.nextIndex - 1;
        } else {
          // Nested object
          if (!Array.isArray(parent)) {
            parent[key] = {};
            stack.push(parent[key]);
          }
          indentStack.push(indent);
        }
      } else {
        // Simple value
        if (!Array.isArray(parent)) {
          parent[key] = parseValue(value);
        }
      }

      // Reset list tracking if we're at a new key
      if (indent <= currentListIndent) {
        currentList = null;
        currentListIndent = -1;
      }
    }
  }

  return result;
}

/**
 * Parse a multiline string (| or > indicators)
 */
function parseMultilineString(
  lines: string[],
  startIndex: number,
  expectedIndent: number,
): {
  value: string;
  nextIndex: number;
} {
  const result: string[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;

    if (line.trim() && indent < expectedIndent) {
      break;
    }

    if (indent >= expectedIndent) {
      result.push(line.substring(expectedIndent));
    } else if (!line.trim()) {
      result.push('');
    } else {
      break;
    }

    i++;
  }

  return {
    value: result.join('\n').trimEnd(),
    nextIndex: i,
  };
}

/**
 * Parse a key-value pair string into an object
 */
function parseKeyValue(str: string): Record<string, any> {
  const result: Record<string, any> = {};
  const pairs = str.split(', ');

  for (const pair of pairs) {
    if (pair.includes(': ')) {
      const [key, value] = pair.split(': ');
      result[key.trim()] = parseValue(value.trim());
    }
  }

  return result;
}

/**
 * Parse a YAML value (handle different types)
 */
function parseValue(value: string): YamlData {
  // Null
  if (value === 'null' || value === '~' || value === '') {
    return null;
  }

  // Boolean
  if (value === 'true' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === 'false' || value === 'no' || value === 'off') {
    return false;
  }

  // Number
  if (!isNaN(Number(value)) && value !== '') {
    if (value.includes('.')) {
      return parseFloat(value);
    }
    return parseInt(value, 10);
  }

  // String with quotes
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Array notation
  if (value.startsWith('[') && value.endsWith(']')) {
    const items = value
      .slice(1, -1)
      .split(',')
      .map((item) => parseValue(item.trim()));
    return items;
  }

  // Object notation
  if (value.startsWith('{') && value.endsWith('}')) {
    const obj: Record<string, any> = {};
    const pairs = value.slice(1, -1).split(',');
    for (const pair of pairs) {
      const [key, val] = pair.split(':').map((s) => s.trim());
      obj[key] = parseValue(val);
    }
    return obj;
  }

  // Default to string
  return value;
}

/**
 * Convert an object to YAML string
 */
export function stringifyYAML(obj: YamlData, indent: number = 0): string {
  const lines: string[] = [];
  const indentStr = '  '.repeat(indent);

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (typeof item === 'object' && item !== null) {
        lines.push(`${indentStr}- ${stringifyYAML(item, 0).trim()}`);
      } else {
        lines.push(`${indentStr}- ${item}`);
      }
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) {
        lines.push(`${indentStr}${key}:`);
      } else if (Array.isArray(value)) {
        lines.push(`${indentStr}${key}:`);
        lines.push(stringifyYAML(value, indent + 1));
      } else if (typeof value === 'object') {
        lines.push(`${indentStr}${key}:`);
        lines.push(stringifyYAML(value, indent + 1));
      } else if (typeof value === 'string' && value.includes('\n')) {
        lines.push(`${indentStr}${key}: |`);
        value.split('\n').forEach((line) => {
          lines.push(`${'  '.repeat(indent + 1)}${line}`);
        });
      } else {
        lines.push(`${indentStr}${key}: ${value}`);
      }
    }
  } else {
    return String(obj);
  }

  return lines.join('\n');
}
