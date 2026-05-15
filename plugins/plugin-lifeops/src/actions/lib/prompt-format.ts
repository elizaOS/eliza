export function formatPromptValue(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : "(empty)";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((entry) => {
        const rendered = formatPromptValue(entry, indent + 2);
        return rendered.includes("\n")
          ? `${pad}-\n${indentLines(rendered, indent + 2)}`
          : `${pad}- ${rendered}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, entry]) => {
        const rendered = formatPromptValue(entry, indent + 2);
        return rendered.includes("\n")
          ? `${pad}${key}:\n${indentLines(rendered, indent + 2)}`
          : `${pad}${key}: ${rendered}`;
      })
      .join("\n");
  }
  return String(value);
}

export function formatPromptSection(label: string, value: unknown): string {
  return `${label}:\n${formatPromptValue(value)}`;
}

function indentLines(value: string, indent: number): string {
  const pad = " ".repeat(indent);
  return value
    .split("\n")
    .map((line) => (line.length > 0 ? `${pad}${line}` : line))
    .join("\n");
}
