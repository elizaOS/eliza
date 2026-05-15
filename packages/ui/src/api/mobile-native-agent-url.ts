export const IOS_LOCAL_AGENT_IPC_BASE = "eliza-local-agent://ipc";
export const MOBILE_LOCAL_AGENT_PORT = "31337";

export type MobileNativeLocalAgentUrlKind = "ios-ipc" | "http-loopback";

export interface MobileNativeLocalAgentUrl {
  kind: MobileNativeLocalAgentUrlKind;
  baseUrl: string;
  path: string;
  url: URL;
}

function parseUrl(
  value: string | URL,
  base = `${IOS_LOCAL_AGENT_IPC_BASE}/`,
): URL | null {
  try {
    return value instanceof URL ? value : new URL(value, base);
  } catch {
    return null;
  }
}

export function normalizeLoopbackHost(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

export function isLoopbackLocalAgentHost(hostname: string): boolean {
  const host = normalizeLoopbackHost(hostname);
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

export function isIosLocalAgentIpcUrl(value: string | URL): boolean {
  const url = parseUrl(value);
  return url?.protocol === "eliza-local-agent:" && url.hostname === "ipc";
}

export function parseMobileNativeLocalAgentUrl(
  value: string | URL,
): MobileNativeLocalAgentUrl | null {
  const url = parseUrl(value);
  if (!url) return null;

  if (isIosLocalAgentIpcUrl(url)) {
    return {
      kind: "ios-ipc",
      baseUrl: IOS_LOCAL_AGENT_IPC_BASE,
      path: `${url.pathname}${url.search}`,
      url,
    };
  }

  if (
    url.protocol === "http:" &&
    url.port === MOBILE_LOCAL_AGENT_PORT &&
    isLoopbackLocalAgentHost(url.hostname)
  ) {
    return {
      kind: "http-loopback",
      baseUrl: `${url.protocol}//${url.host}`,
      path: `${url.pathname}${url.search}`,
      url,
    };
  }

  return null;
}

export function isMobileNativeLocalAgentUrl(value: string | URL): boolean {
  return parseMobileNativeLocalAgentUrl(value) !== null;
}

export function isAndroidNativeLocalAgentUrl(value: string | URL): boolean {
  const parsed = parseMobileNativeLocalAgentUrl(value);
  return parsed?.kind === "http-loopback";
}

export function localAgentPathFromUrl(value: string | URL): string {
  const parsed = parseMobileNativeLocalAgentUrl(value);
  if (parsed) return parsed.path;
  const url = parseUrl(value);
  if (!url) throw new TypeError("Invalid local-agent URL");
  return `${url.pathname}${url.search}`;
}
