import { readFileSync } from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";

const port = Number(process.env.PORT || 8080);
const upstream = (
  process.env.BITROUTER_UPSTREAM || "http://127.0.0.1:4356"
).replace(/\/+$/, "");
const token = process.env.BITROUTER_PROXY_TOKEN;
const internalJwtFile =
  process.env.BITROUTER_INTERNAL_JWT_FILE || "/data/internal.jwt";
const auditMode = "buffer-v1";
const cerebrasPricingPerMillion = new Map([
  ["gpt-oss-120b", { input: 0.35, output: 0.75 }],
  ["zai-glm-4.7", { input: 2.25, output: 2.75 }],
]);

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

function normalizeModelId(model) {
  if (typeof model !== "string") return null;
  if (model.startsWith("cerebras:")) return model.slice("cerebras:".length);
  if (model.startsWith("cerebras/")) return model.slice("cerebras/".length);
  return model;
}

function numberFromUsage(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function getRequestedModel(target, contentType, body) {
  if (
    !target.pathname.endsWith("/chat/completions") ||
    !contentType.includes("application/json") ||
    body.length === 0
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(body.toString("utf-8"));
    return normalizeModelId(parsed?.model);
  } catch {
    return null;
  }
}

function isJsonChatCompletion(target, contentType) {
  return (
    target.pathname.endsWith("/chat/completions") &&
    contentType.includes("application/json")
  );
}

function auditJsonCompletionCost(response, requestedModel, responseBody) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return;

  try {
    const body = JSON.parse(responseBody.toString("utf-8"));
    if (!response.ok || !body || typeof body !== "object") return;

    const model = normalizeModelId(body.model) ?? requestedModel;
    const pricing = model ? cerebrasPricingPerMillion.get(model) : null;
    if (!pricing) return;

    const usage = body.usage || {};
    const inputTokens = numberFromUsage(
      usage.prompt_tokens ?? usage.input_tokens,
    );
    const outputTokens = numberFromUsage(
      usage.completion_tokens ?? usage.output_tokens,
    );
    const costUsd =
      (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

    console.log(
      JSON.stringify({
        event: "bitrouter_proxy_usage_cost",
        provider: "cerebras",
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: Number(costUsd.toFixed(8)),
      }),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "bitrouter_proxy_usage_cost_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    writeJson(res, 200, { status: "ok", costAudit: true, auditMode });
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
    const requestBody =
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : await readRequestBody(req);
    const requestedModel = requestBody
      ? getRequestedModel(
          target,
          headers.get("content-type") || "",
          requestBody,
        )
      : null;
    const response = await fetch(target, {
      method: req.method,
      headers,
      body: requestBody,
      duplex: "half",
    });
    const responseContentType = response.headers.get("content-type") || "";

    res.writeHead(
      response.status,
      Object.fromEntries(response.headers.entries()),
    );
    if (isJsonChatCompletion(target, responseContentType)) {
      const responseBody = Buffer.from(await response.arrayBuffer());
      auditJsonCompletionCost(response, requestedModel, responseBody);
      res.end(responseBody);
      return;
    }

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
  console.log(`bitrouter auth proxy listening on ${port} (${auditMode})`);
});
