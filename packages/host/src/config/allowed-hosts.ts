/**
 * Parses `ELIZA_ALLOWED_HOSTS` into canonical host patterns consumed by Vite
 * host checks and Capacitor navigation configuration. Inputs may be bare
 * hosts or HTTP(S) origins, with optional subdomain wildcards.
 */
export type AllowedHostPattern = {
  readonly host: string;
  readonly includeSubdomains: boolean;
};

function parseHostPattern(rawValue: string): AllowedHostPattern {
  const value = rawValue.trim();
  if (!value) {
    throw new Error("ELIZA_ALLOWED_HOSTS contains an empty host entry");
  }
  if (
    [...value].some((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 0x20 || codePoint === 0x7f;
    })
  ) {
    throw new Error(
      `ELIZA_ALLOWED_HOSTS entry is not a supported host pattern: ${rawValue}`,
    );
  }

  let hostValue = value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(
        `ELIZA_ALLOWED_HOSTS entry has unsupported protocol: ${rawValue}`,
      );
    }
    if (url.pathname !== "/" || value.includes("?") || value.includes("#")) {
      throw new Error(
        `ELIZA_ALLOWED_HOSTS entry must be a host, not a URL path: ${rawValue}`,
      );
    }
    if (url.username || url.password || value.includes("@")) {
      throw new Error(
        `ELIZA_ALLOWED_HOSTS entry must not contain credentials: ${rawValue}`,
      );
    }
    hostValue = url.hostname;
  }

  const includeSubdomains =
    hostValue.startsWith("*.") || hostValue.startsWith(".");
  const candidate = includeSubdomains
    ? hostValue.replace(/^(\*\.)|\./, "")
    : hostValue;
  const candidateForUrl =
    candidate.indexOf(":") !== candidate.lastIndexOf(":") &&
    !candidate.startsWith("[")
      ? `[${candidate}]`
      : candidate;

  let parsedHost: URL;
  try {
    parsedHost = new URL(`http://${candidateForUrl}`);
  } catch {
    // error-policy:J3 Invalid configuration is rejected at its parsing boundary.
    throw new Error(
      `ELIZA_ALLOWED_HOSTS entry is not a supported host pattern: ${rawValue}`,
    );
  }
  if (
    parsedHost.username ||
    parsedHost.password ||
    candidate.includes("@") ||
    parsedHost.pathname !== "/" ||
    parsedHost.search ||
    parsedHost.hash
  ) {
    throw new Error(
      `ELIZA_ALLOWED_HOSTS entry is not a supported host pattern: ${rawValue}`,
    );
  }

  const host = parsedHost.hostname.toLowerCase().replace(/\.$/, "");
  const isIpLiteral = host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (
    !host ||
    host.endsWith(".") ||
    host.includes("*") ||
    (includeSubdomains && isIpLiteral)
  ) {
    throw new Error(
      `ELIZA_ALLOWED_HOSTS entry is not a supported host pattern: ${rawValue}`,
    );
  }

  return { host, includeSubdomains };
}

export function parseAllowedHostEnv(
  value: string | undefined | null,
): AllowedHostPattern[] {
  if (value == null) return [];
  const seen = new Set<string>();
  const entries: AllowedHostPattern[] = [];
  for (const raw of value.split(",")) {
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
