/** Parses JSON without permitting duplicate object keys to collapse through last-wins semantics. */

/** Parse one strict JSON value while rejecting decoded duplicate object keys. */
export function parseStrictJson(source: string, label: string): unknown {
  try {
    const value: unknown = JSON.parse(source);
    // JSON.parse owns grammar validation. Scan only structural tokens and
    // complete strings to check decoded keys without building another AST.
    const scopes: Array<Set<string> | null> = [];
    const tokens = /"(?:[^"\\]|\\.)*"|[{}[\]:,]/g;
    for (const match of source.matchAll(tokens)) {
      const token = match[0];
      if (token === "{") scopes.push(new Set());
      else if (token === "[") scopes.push(null);
      else if (token === "}" || token === "]") scopes.pop();
      else if (token.startsWith('"')) {
        let next = match.index + token.length;
        while (/\s/.test(source[next] ?? "")) next++;
        if (source[next] !== ":") continue;
        const keys = scopes.at(-1);
        const key: string = JSON.parse(token);
        if (!keys || keys.has(key)) {
          throw new Error(`Duplicate JSON object key: ${key}`);
        }
        keys.add(key);
      }
    }
    return value;
  } catch (error) {
    throw new TypeError(`${label} is not valid strict JSON`, { cause: error });
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
