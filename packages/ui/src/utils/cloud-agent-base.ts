function stripTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

function normalizeHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function directSharedAgentPath(pathname: string): {
  apiPath: string;
  hasBridgeSuffix: boolean;
} | null {
  const path = stripTrailingSlash(pathname);
  const match = /^\/api\/v1\/eliza\/agents\/[^/]+(\/bridge)?$/.exec(path);
  if (!match) return null;
  const hasBridgeSuffix = Boolean(match[1]);
  return {
    apiPath: hasBridgeSuffix ? path.slice(0, -"/bridge".length) : path,
    hasBridgeSuffix,
  };
}

/**
 * Shared-runtime Cloud agents expose REST at
 * `/api/v1/eliza/agents/:id` and JSON-RPC at the sibling `/bridge`.
 */
export function normalizeDirectCloudSharedAgentApiBase(value: string): string {
  const trimmed = stripTrailingSlash(value.trim());
  if (!trimmed) return trimmed;
  const url = normalizeHttpUrl(trimmed);
  if (!url) return trimmed;
  const sharedPath = directSharedAgentPath(url.pathname);
  if (!sharedPath) return trimmed;
  url.pathname = sharedPath.apiPath;
  url.search = "";
  url.hash = "";
  return stripTrailingSlash(url.toString());
}

export function isDirectCloudSharedAgentApiBase(value: string): boolean {
  const normalized = normalizeDirectCloudSharedAgentApiBase(value);
  const url = normalizeHttpUrl(normalized);
  if (!url) return false;
  const sharedPath = directSharedAgentPath(url.pathname);
  return Boolean(sharedPath && !sharedPath.hasBridgeSuffix);
}
