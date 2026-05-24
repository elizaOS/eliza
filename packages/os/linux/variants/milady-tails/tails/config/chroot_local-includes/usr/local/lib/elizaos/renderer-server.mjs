#!/opt/milady/bin/bun

import { extname, join, normalize, resolve } from "node:path";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.ELIZAOS_RENDERER_PORT || "5174", 10);
const rendererRoot = resolve(
  process.env.ELIZAOS_RENDERER_ROOT || "/opt/milady/Resources/app/renderer",
);
const apiBase =
  process.env.ELIZA_DESKTOP_API_BASE ||
  process.env.ELIZA_API_BASE ||
  `http://127.0.0.1:${process.env.ELIZA_API_PORT || "31337"}`;

const proxyPrefixes = ["/api", "/ws", "/music-player"];
const textMimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

function headersFor(filePath) {
  const headers = new Headers();
  const type = textMimeTypes.get(extname(filePath));
  if (type) headers.set("content-type", type);
  headers.set("cache-control", "no-store");
  return headers;
}

function staticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const normalized = normalize(decoded === "/" ? "/index.html" : decoded);
  if (normalized.includes("\0")) return null;

  const relative = normalized.replace(/^[/\\]+/, "");
  const target = resolve(join(rendererRoot, relative));
  if (target !== rendererRoot && !target.startsWith(`${rendererRoot}/`)) {
    return null;
  }
  return target;
}

function bootScript() {
  const nativeInfo = {
    name: "elizaOS",
    appName: "elizaOS",
    appId: "ai.elizaos.app",
    namespace: "eliza",
    urlScheme: "elizaos",
    platform: "elizaos-live",
  };
  const bootConfig = {
    branding: {
      appName: "elizaOS",
      orgName: "elizaOS",
      repoName: "eliza",
      docsUrl: "https://docs.elizaos.ai",
      appUrl: "https://elizaos.ai",
      bugReportUrl: "https://github.com/elizaOS/eliza/issues/new",
      hashtag: "#elizaOS",
      fileExtension: ".eliza-agent",
      packageScope: "elizaos",
    },
    assetBaseUrl: "/",
    apiBase,
  };

  return `<script>
(() => {
  const apiBase = ${JSON.stringify(apiBase)};
  const nativeInfo = ${JSON.stringify(nativeInfo)};
  const bootConfig = ${JSON.stringify(bootConfig)};
  window.__ELIZA_API_BASE__ = apiBase;
  window.__ELIZAOS_APP_BOOT_CONFIG__ = Object.assign(
    {},
    window.__ELIZAOS_APP_BOOT_CONFIG__ || {},
    bootConfig,
    {
      branding: Object.assign(
        {},
        bootConfig.branding,
        (window.__ELIZAOS_APP_BOOT_CONFIG__ || {}).branding || {}
      ),
    }
  );
  window.__ELIZA_BOOT_CONFIG__ = Object.assign(
    {},
    window.__ELIZA_BOOT_CONFIG__ || {},
    nativeInfo,
    { bootConfig: window.__ELIZAOS_APP_BOOT_CONFIG__ }
  );
  window.ElizaNative = Object.assign({
    platform: "elizaos-live",
    getLocalAgentToken: () => null,
    getAppInfo: () => nativeInfo
  }, window.ElizaNative || {});
})();
</script>`;
}

async function staticResponse(filePath) {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;

  if (filePath.endsWith("/index.html") || filePath.endsWith("index.html")) {
    const html = await file.text();
    return new Response(html.replace("</head>", `${bootScript()}\n</head>`), {
      headers: headersFor(filePath),
    });
  }

  return new Response(file, { headers: headersFor(filePath) });
}

function shouldProxy(pathname) {
  return proxyPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function proxyRequest(request, url) {
  const target = new URL(url.pathname + url.search, apiBase);
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  }

  const headers = new Headers(request.headers);
  headers.set("host", target.host);
  const method = request.method.toUpperCase();
  return fetch(target, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
}

Bun.serve({
  hostname: host,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (shouldProxy(url.pathname)) {
      return proxyRequest(request, url);
    }

    const filePath = staticPath(url.pathname);
    if (!filePath) {
      return new Response("Forbidden", { status: 403 });
    }

    const response = await staticResponse(filePath);
    if (response) return response;

    const fallback = await staticResponse(join(rendererRoot, "index.html"));
    return fallback ?? new Response("Not found", { status: 404 });
  },
});

console.log(
  `[elizaOS renderer] serving ${rendererRoot} on http://${host}:${port} -> ${apiBase}`,
);
