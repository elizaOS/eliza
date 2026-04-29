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
    proxy = http.createServer(async (req, res) => {
      const method = (req.method ?? "GET").toUpperCase();
      const targetUrl = new URL(req.url ?? "/", upstreamBaseUrl);
      requests.push(`${method} ${targetUrl.pathname}`);

      const body =
        method === "GET" || method === "HEAD" ? undefined : await readBody(req);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          headers.set(key, value);
          continue;
        }
        if (Array.isArray(value)) {
          headers.set(key, value.join(", "));
        }
      }

      const response = await fetch(targetUrl, {
        method,
        headers,
        body,
        redirect: "manual",
      });

      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      if (!response.body) {
        res.end();
        return;
      }

      res.end(Buffer.from(await response.arrayBuffer()));
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
