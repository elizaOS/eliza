/** Reject ambiguous/malformed values; descriptions never become diagnostic fields. */
export function readAllowedServerTiming<const Names extends readonly string[]>(
  raw: string | null,
  names: Names,
): Partial<Record<Names[number], number>> | undefined {
  if (!raw || raw.length > 4096 || /[\r\n]/.test(raw)) return undefined;
  // Remove complete quoted values before splitting so commas in descriptions
  // cannot introduce a fake metric. Unbalanced quotes reject the whole header.
  const numeric = raw.replace(/"(?:[^"\\]|\\.)*"/g, "");
  if (numeric.includes('"')) return undefined;
  const metrics: Partial<Record<Names[number], number>> = {};
  const seen = new Set<Names[number]>();
  for (const entry of numeric.split(",").slice(0, 64)) {
    const [label, ...params] = entry.split(";");
    const name = label?.trim().toLowerCase() as Names[number];
    if (!names.includes(name)) continue;
    if (seen.has(name)) {
      delete metrics[name];
      continue;
    }
    seen.add(name);
    const durations = params
      .map((p) => p.trim())
      .filter((p) => /^dur=/i.test(p));
    if (durations.length !== 1) continue;
    const value = durations[0].slice(4);
    if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,3})?$/.test(value)) continue;
    const duration = Number(value);
    if (duration <= 600_000) metrics[name] = duration;
  }
  return Object.keys(metrics).length ? metrics : undefined;
}
