export function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const idx = line.indexOf(":");
    if (idx <= 0) continue;

    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name) headers[name] = value;
  }

  return headers;
}

export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const idx = line.indexOf("=");
    if (idx <= 0) continue;

    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name) env[name] = value;
  }

  return env;
}
