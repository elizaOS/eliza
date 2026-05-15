/**
 * Derive a valid PostgreSQL schema name from a plugin name
 */
export function deriveSchemaName(pluginName: string): string {
  // Remove common prefixes and convert to lowercase with underscores
  let schemaName = pluginName
    .replace(/^@[^/]+\//, "") // Remove npm scope like @elizaos/
    .replace(/^plugin-/, "") // Remove plugin- prefix
    .toLowerCase();

  // Replace non-alphanumeric characters with underscores (avoid polynomial regex)
  schemaName = normalizeSchemaName(schemaName);

  // Ensure schema name is valid (not empty, not a reserved word)
  const reserved = ["public", "pg_catalog", "information_schema", "migrations"];
  if (!schemaName || reserved.includes(schemaName)) {
    // Fallback to using the full plugin name with safe characters
    schemaName = `plugin_${normalizeSchemaName(pluginName.toLowerCase())}`;
  }

  // Ensure it starts with a letter (PostgreSQL requirement)
  if (!/^[a-z]/.test(schemaName)) {
    schemaName = `p_${schemaName}`;
  }

  // Truncate if too long (PostgreSQL identifier limit is 63 chars)
  if (schemaName.length > 63) {
    schemaName = schemaName.substring(0, 63);
  }

  return schemaName;
}

/**
 * Normalize a string to be a valid PostgreSQL identifier
 * Avoids polynomial regex by using string manipulation instead
 */
function normalizeSchemaName(input: string): string {
  const chars: string[] = [];
  let prevWasUnderscore = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (/[a-z0-9]/.test(char)) {
      chars.push(char);
      prevWasUnderscore = false;
    } else if (!prevWasUnderscore) {
      // Only add underscore if previous char wasn't already an underscore
      chars.push("_");
      prevWasUnderscore = true;
    }
    // Skip consecutive non-alphanumeric characters
  }

  // Remove leading and trailing underscores
  const result = chars.join("");

  // Trim underscores from start and end efficiently
  let start = 0;
  let end = result.length;

  while (start < end && result[start] === "_") {
    start++;
  }

  while (end > start && result[end - 1] === "_") {
    end--;
  }

  return result.slice(start, end);
}
