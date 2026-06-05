import http from "node:http";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

const port = Number(process.env.PORT || 8080);
const upstream = (process.env.BITROUTER_UPSTREAM || "http://127.0.0.1:4356").replace(/\/+$/, "");
const token = process.env.BITROUTER_PROXY_TOKEN;
const internalJwtFile = process.env.BITROUTER_INTERNAL_JWT_FILE || "/data/internal.jwt";
const openRouterApiKey = process.env.OPENROUTER_API_KEY || process.env.BITROUTER_OPENROUTER_API_KEY;
const cerebrasApiKey = process.env.BITROUTER_CEREBRAS_API_KEY || process.env.CEREBRAS_API_KEY;
const proxyVersion = "forced-provider-v1";

if (!token) {
  throw new Error("BITROUTER_PROXY_TOKEN is required");
}

function isAuthorized(req) {
  const header = req.headers.authorization || "";
  return header === `Bearer ${token}`;
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function getInternalAuthorization() {
  return `Bearer ${readFileSync(internalJwtFile, "utf-8").trim()}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

function jsonHeaders(headers) {
  const next = new Headers(headers);
  next.delete("host");
  next.delete("content-length");
  return next;
}

async function maybeProxyForcedProvider(req, res, target) {
  if (req.method !== "POST" || target.pathname !== "/v1/chat/completions") {
    return false;
  }

  const rawBody = await readBody(req);
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { rawBody };
  }

  if (typeof body.model !== "string") {
    return { rawBody };
  }

  const forcedRoutes = [
    {
      prefix: "openrouter:",
      apiKey: openRouterApiKey,
      apiBase: "https://openrouter.ai/api/v1",
    },
    {
      prefix: "cerebras:",
      apiKey: cerebrasApiKey,
      apiBase: "https://api.cerebras.ai/v1",
    },
  ];
  const forced = forcedRoutes.find((route) => body.model.startsWith(route.prefix));
  if (!forced) {
    return { rawBody };
  }
  if (!forced.apiKey) {
    writeJson(res, 502, {
      error: {
        message: `${forced.prefix.slice(0, -1)} API key is not configured`,
        type: "bitrouter_proxy_error",
        code: "provider_api_key_missing",
      },
    });
    return true;
  }

  body.model = body.model.slice(forced.prefix.length);
  if (forced.prefix === "cerebras:" && body.model === "zai-glm-4.7" && body.reasoning_effort === undefined) {
    body.reasoning_effort = "none";
  }

  const headers = jsonHeaders(req.headers);
  headers.set("authorization", `Bearer ${forced.apiKey}`);
  headers.set("content-type", "application/json");

  const response = await fetch(`${forced.apiBase}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) {
    Readable.fromWeb(response.body).pipe(res);
  } else {
    res.end();
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    writeJson(res, 200, { status: "ok", proxyVersion });
    return;
  }

  if (!isAuthorized(req)) {
    writeJson(res, 401, {
      error: {
        message: "Unauthorized",
        type: "unauthorized",
        code: "unauthorized",
      },
    });
    return;
  }

  try {
    const target = new URL(req.url || "/", upstream);
    const forcedResult = await maybeProxyForcedProvider(req, res, target);
    if (forcedResult === true) return;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (key.toLowerCase() === "host") continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else {
        headers.set(key, value);
      }
    }
    headers.set("authorization", getInternalAuthorization());
    const response = await fetch(target, {
      method: req.method,
      headers,
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : forcedResult?.rawBody !== undefined
            ? forcedResult.rawBody
            : Readable.toWeb(req),
      duplex: "half",
    });

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    writeJson(res, 502, {
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: "bitrouter_proxy_error",
        code: "bitrouter_proxy_failed",
      },
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`bitrouter auth proxy ${proxyVersion} listening on ${port}`);
});
