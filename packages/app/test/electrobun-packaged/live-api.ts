import http from "node:http";
import type { AddressInfo } from "node:net";
import { startApiServer } from "../../../app-core/src/api/server.ts";
import { useIsolatedConfigEnv as isolatedConfigEnv } from "../../../app-core/test/helpers/isolated-config.ts";
import { createRealTestRuntime } from "../../../app-core/test/helpers/real-runtime.ts";

export interface TestApiServerOptions {
  port?: number;
  onboardingComplete?: boolean;
}

export interface TestApiServer {
  baseUrl: string;
  requests: string[];
  close: () => Promise<void>;
}

async function readBody(
  req: http.IncomingMessage,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return Buffer.concat(chunks);
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function buildForwardHeaders(req: http.IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    if (typeof value === "string") {
      headers.set(key, value);
      continue;
    }
    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    }
  }
  return headers;
}

function copyResponseHeaders(source: Headers, res: http.ServerResponse): void {
  source.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
}

function writeCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader(
    "access-control-allow-methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  res.setHeader(
    "access-control-allow-headers",
    "authorization,content-type,x-api-key",
  );
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.statusCode = statusCode;
  writeCorsHeaders(res);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function parseJsonBody(body: Buffer | undefined): Record<string, unknown> {
  if (!body || body.length === 0) {
    return {};
  }
  const parsed = JSON.parse(body.toString("utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function scrubResetConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...config };
  const meta =
    next.meta && typeof next.meta === "object" && !Array.isArray(next.meta)
      ? { ...(next.meta as Record<string, unknown>) }
      : {};
  delete meta.onboardingComplete;
  next.meta = meta;
  delete next.serviceRouting;
  delete next.deployment;
  delete next.agents;
  return next;
}

export async function startLiveApiServer(
  options: TestApiServerOptions = {},
): Promise<TestApiServer> {
  const configEnv = isolatedConfigEnv("eliza-packaged-live-api-");
  let runtimeResult: Awaited<ReturnType<typeof createRealTestRuntime>> | null =
    null;
  let upstream: Awaited<ReturnType<typeof startApiServer>> | null = null;
  let proxy: http.Server | null = null;

  try {
    runtimeResult = await createRealTestRuntime({
      characterName: "PackagedDesktopTest",
    });
    upstream = await startApiServer({
      port: 0,
      runtime: runtimeResult.runtime,
      skipDeferredStartupWork: true,
    });
    const upstreamBaseUrl = `http://127.0.0.1:${upstream.port}`;

    if (options.onboardingComplete) {
      const response = await fetch(`${upstreamBaseUrl}/api/onboarding`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Packaged Desktop" }),
      });
      if (!response.ok) {
        throw new Error(
          `Failed to seed live onboarding state (${response.status}): ${await response.text()}`,
        );
      }
    }

    const requests: string[] = [];
    let configPatch: Record<string, unknown> = {};
    let resetApplied = false;
    proxy = http.createServer(async (req, res) => {
      try {
        const method = (req.method ?? "GET").toUpperCase();
        const targetUrl = new URL(req.url ?? "/", upstreamBaseUrl);
        requests.push(`${method} ${targetUrl.pathname}`);

        if (method === "POST" && targetUrl.pathname === "/api/agent/reset") {
          resetApplied = true;
          configPatch = {};
          sendJson(res, 200, { ok: true });
          return;
        }

        if (
          method === "GET" &&
          resetApplied &&
          targetUrl.pathname === "/api/onboarding/status"
        ) {
          sendJson(res, 200, { complete: false, cloudProvisioned: false });
          return;
        }

        if (targetUrl.pathname === "/api/config") {
          if (method === "PUT") {
            const body = await readBody(req);
            configPatch = { ...configPatch, ...parseJsonBody(body) };
            resetApplied = false;
            sendJson(res, 200, configPatch);
            return;
          }

          if (method === "GET") {
            const response = await fetch(targetUrl, {
              method,
              headers: buildForwardHeaders(req),
              redirect: "manual",
            });
            const upstreamConfig = response.ok
              ? parseJsonBody(Buffer.from(await response.arrayBuffer()))
              : {};
            sendJson(res, response.ok ? 200 : response.status, {
              ...(resetApplied
                ? scrubResetConfig(upstreamConfig)
                : upstreamConfig),
              ...configPatch,
            });
            return;
          }
        }

        const body =
          method === "GET" || method === "HEAD"
            ? undefined
            : await readBody(req);
        const response = await fetch(targetUrl, {
          method,
          headers: buildForwardHeaders(req),
          body,
          redirect: "manual",
        });

        res.statusCode = response.status;
        copyResponseHeaders(response.headers, res);

        if (!response.body) {
          res.end();
          return;
        }

        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        res.statusCode = 502;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(error instanceof Error ? error.message : String(error));
      }
    });

    await listen(proxy, options.port ?? 0);
    const address = proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve packaged live API proxy address.");
    }

    return {
      baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
      requests,
      close: async () => {
        await closeServer(proxy).catch(() => undefined);
        await upstream.close().catch(() => undefined);
        await runtimeResult.cleanup().catch(() => undefined);
        await configEnv.restore().catch(() => undefined);
      },
    };
  } catch (error) {
    if (proxy) {
      await closeServer(proxy).catch(() => undefined);
    }
    await upstream?.close().catch(() => undefined);
    await runtimeResult?.cleanup().catch(() => undefined);
    await configEnv.restore().catch(() => undefined);
    throw error;
  }
}
