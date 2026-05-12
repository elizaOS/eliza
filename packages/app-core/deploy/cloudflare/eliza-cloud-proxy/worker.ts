const DEFAULT_UPSTREAM_ORIGIN = "https://www.elizacloud.ai";
const DEFAULT_ALLOWED_ORIGINS: string[] = [];

type Env = {
  ELIZA_CLOUD_ORIGIN?: string;
  CF_ALLOWED_ORIGINS?: string;
  CF_PROXY_PATH_PREFIXES?: string;
  ALLOWED_ORIGINS?: string;
  PROXY_PATH_PREFIXES?: string;
};

function resolveUpstreamOrigin(env: Env): string {
  return (env.ELIZA_CLOUD_ORIGIN || DEFAULT_UPSTREAM_ORIGIN).replace(
    /\/+$/,
    "",
  );
}

function resolveAllowedOrigins(env: Env): Set<string> {
  const configured = (env.CF_ALLOWED_ORIGINS || env.ALLOWED_ORIGINS)
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return new Set(configured?.length ? configured : DEFAULT_ALLOWED_ORIGINS);
}

function resolveProxyPathPrefixes(env: Env): string[] {
  return (env.CF_PROXY_PATH_PREFIXES || env.PROXY_PATH_PREFIXES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function shouldProxyPath(pathname: string, pathPrefixes: string[]): boolean {
  return pathPrefixes.some((prefix) =>
    prefix.endsWith("/")
      ? pathname.startsWith(prefix)
      : pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function applyCorsHeaders(
  responseHeaders: Headers,
  requestOrigin: string | null,
  allowedOrigins: Set<string>,
): void {
  responseHeaders.set(
    "Access-Control-Allow-Methods",
    "GET,POST,DELETE,OPTIONS",
  );
  responseHeaders.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Service-Key, X-API-Key",
  );
  responseHeaders.set("Access-Control-Max-Age", "86400");
  responseHeaders.set("Vary", "Origin");

  if (requestOrigin && allowedOrigins.has(requestOrigin)) {
    responseHeaders.set("Access-Control-Allow-Origin", requestOrigin);
  } else {
    responseHeaders.delete("Access-Control-Allow-Origin");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathPrefixes = resolveProxyPathPrefixes(env);
    if (!shouldProxyPath(url.pathname, pathPrefixes)) {
      return new Response("Not found", { status: 404 });
    }

    const allowedOrigins = resolveAllowedOrigins(env);
    const requestOrigin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      const headers = new Headers();
      applyCorsHeaders(headers, requestOrigin, allowedOrigins);
      return new Response(null, { status: 204, headers });
    }

    const upstreamUrl = new URL(
      `${url.pathname}${url.search}`,
      `${resolveUpstreamOrigin(env)}/`,
    );
    const headers = new Headers(request.headers);
    headers.set("host", upstreamUrl.host);

    const upstreamResponse = await fetch(upstreamUrl.toString(), {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : request.body,
      redirect: "manual",
    });

    const responseHeaders = new Headers(upstreamResponse.headers);
    applyCorsHeaders(responseHeaders, requestOrigin, allowedOrigins);
    responseHeaders.delete("content-length");

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  },
};
