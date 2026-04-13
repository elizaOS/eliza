const DEFAULT_UPSTREAM_ORIGIN = "https://www.elizacloud.ai";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://app.milady.ai",
  "https://milady.ai",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const PROXY_PATH_PREFIXES = [
  "/api/auth/cli-session",
  "/api/compat/",
  "/api/v1/milady/launch-sessions/",
];

type Env = {
  ELIZA_CLOUD_ORIGIN?: string;
  ALLOWED_ORIGINS?: string;
};

function resolveUpstreamOrigin(env: Env): string {
  return (env.ELIZA_CLOUD_ORIGIN || DEFAULT_UPSTREAM_ORIGIN).replace(
    /\/+$/,
    "",
  );
}

function resolveAllowedOrigins(env: Env): Set<string> {
  const configured = env.ALLOWED_ORIGINS?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return new Set(configured?.length ? configured : DEFAULT_ALLOWED_ORIGINS);
}

function shouldProxyPath(pathname: string): boolean {
  return PROXY_PATH_PREFIXES.some((prefix) =>
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
    if (!shouldProxyPath(url.pathname)) {
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
