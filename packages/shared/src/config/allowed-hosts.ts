export type AllowedHostPattern = {
  readonly host: string;
  readonly includeSubdomains: boolean;
};

function parseHostPattern(rawValue: string): AllowedHostPattern {
  let value = rawValue.trim();
  if (!value) {
    throw new Error("MILADY_ALLOWED_HOSTS contains an empty host entry");
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(
        `MILADY_ALLOWED_HOSTS entry has unsupported protocol: ${rawValue}`,
      );
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      throw new Error(
        `MILADY_ALLOWED_HOSTS entry must be a host, not a URL path: ${rawValue}`,
      );
    }
    value = url.hostname;
  }

  const includeSubdomains = value.startsWith("*.") || value.startsWith(".");
  const host = (
    includeSubdomains ? value.replace(/^(\*\.)|\./, "") : value
  ).toLowerCase();
  if (!host || host.includes("/") || host.includes("*")) {
    throw new Error(
      `MILADY_ALLOWED_HOSTS entry is not a supported host pattern: ${rawValue}`,
    );
  }

  return { host, includeSubdomains };
}

export function parseAllowedHostEnv(
  value: string | undefined,
): AllowedHostPattern[] {
  const seen = new Set<string>();
  const entries: AllowedHostPattern[] = [];
  for (const raw of (value ?? "").split(",")) {
    if (!raw.trim()) continue;
    const entry = parseHostPattern(raw);
    const key = `${entry.includeSubdomains ? "*." : ""}${entry.host}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

export function toViteAllowedHosts(
  entries: readonly AllowedHostPattern[],
): string[] {
  return entries.map((entry) =>
    entry.includeSubdomains ? `.${entry.host}` : entry.host,
  );
}

export function toCapacitorAllowNavigation(
  entries: readonly AllowedHostPattern[],
): string[] {
  return entries.map((entry) =>
    entry.includeSubdomains ? `*.${entry.host}` : entry.host,
  );
}
