import http from "node:http";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";

const port = Number(process.env.PORT || 8080);
const upstream = (process.env.BITROUTER_UPSTREAM || "http://127.0.0.1:4356").replace(/\/+$/, "");
const token = process.env.BITROUTER_PROXY_TOKEN;
const internalJwtFile = process.env.BITROUTER_INTERNAL_JWT_FILE || "/data/internal.jwt";

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

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    writeJson(res, 200, { status: "ok" });
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
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req),
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
  console.log(`bitrouter auth proxy listening on ${port}`);
});
