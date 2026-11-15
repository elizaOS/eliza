/**
 * Provider failover when the OpenAI-compatible endpoint is down. The AI SDK
 * reports a refused connection as an APICallError ("Cannot connect to API")
 * that keeps the socket error on `.cause`, so useModel must still try the next
 * TEXT_SMALL provider. Real closed loopback port under Node; the Bun case
 * replays the rejection Bun's fetch raises for the same port.
 *
 * The controls send the same SDK call down the terminal paths: an HTTP 400 or
 * 404 from a live endpoint and a caller abort must not reach the next provider.
 */
import { createServer as createHttpServer, type Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTextSmall } from "../models/text";

/** One request plus the three transient retries of generateTextWithTransientRetry. */
const MAX_REQUESTS_TO_A_DOWN_ENDPOINT = 4;

const runtimes: Array<ReturnType<typeof createSQLiteTestRuntime>> = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
    await runtime.close();
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** A loopback port with nothing listening: the provider process is down. */
async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A live endpoint that answers every request with `status` and an OpenAI error body. */
async function endpointAnswering(status: number, message: string) {
  let requests = 0;
  const server = createHttpServer((request, response) => {
    requests += 1;
    request.resume();
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}/v1`, requests: () => requests };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** Counts only the requests sent to `baseURL`, then hands each call to `send`. */
function countRequestsTo(
  baseURL: string,
  send: (...args: Parameters<typeof fetch>) => Promise<Response>
) {
  const counter = { requests: 0 };
  vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
    if (requestUrl(args[0]).startsWith(baseURL)) counter.requests += 1;
    return send(...args);
  });
  return counter;
}

async function runtimeWithFallbackProvider(baseURL: string) {
  vi.stubEnv("OPENAI_API_KEY", "local-test-key");
  vi.stubEnv("OPENAI_BASE_URL", baseURL);
  vi.stubEnv("CEREBRAS_API_KEY", "");
  vi.stubEnv("ELIZA_PROVIDER", "openai");
  const runtime = createSQLiteTestRuntime({
    character: {
      name: "UnreachableProviderFailover",
      settings: {
        OPENAI_API_KEY: "local-test-key",
        OPENAI_BASE_URL: baseURL,
        OPENAI_SMALL_MODEL: "local-model",
      },
    },
  });
  await runtime.initialize({ skipMigrations: true });
  runtimes.push(runtime);
  const fallback = { calls: 0 };
  runtime.registerModel(ModelType.TEXT_SMALL, handleTextSmall, "openai", 100);
  runtime.registerModel(
    ModelType.TEXT_SMALL,
    async () => {
      fallback.calls += 1;
      return "answer from the fallback provider";
    },
    "fallback-provider",
    1
  );
  return { runtime, fallback };
}

describe("TEXT_SMALL failover when the OpenAI-compatible endpoint is down", () => {
  it("tries the next provider after Node's ECONNREFUSED", async () => {
    const baseURL = `http://127.0.0.1:${await closedLoopbackPort()}/v1`;
    const endpoint = countRequestsTo(baseURL, globalThis.fetch);
    const { runtime, fallback } = await runtimeWithFallbackProvider(baseURL);

    await expect(
      runtime.useModel(ModelType.TEXT_SMALL, { prompt: "Reply briefly." })
    ).resolves.toBe("answer from the fallback provider");
    expect(fallback.calls).toBe(1);
    expect(endpoint.requests).toBeGreaterThan(0);
    expect(endpoint.requests).toBeLessThanOrEqual(MAX_REQUESTS_TO_A_DOWN_ENDPOINT);
  }, 60_000);

  it("tries the next provider after Bun's ConnectionRefused", async () => {
    const baseURL = `http://127.0.0.1:${await closedLoopbackPort()}/v1`;
    // Bun 1.4 rejects fetch to a closed port with this TypeError (no cause),
    // where Node raises `fetch failed` with an ECONNREFUSED cause.
    const endpoint = countRequestsTo(baseURL, async (input) => {
      throw Object.assign(
        new TypeError("Unable to connect. Is the computer able to access the url?"),
        { code: "ConnectionRefused", path: requestUrl(input), errno: 0 }
      );
    });
    const { runtime, fallback } = await runtimeWithFallbackProvider(baseURL);

    await expect(
      runtime.useModel(ModelType.TEXT_SMALL, { prompt: "Reply briefly." })
    ).resolves.toBe("answer from the fallback provider");
    expect(fallback.calls).toBe(1);
    expect(endpoint.requests).toBeGreaterThan(0);
    expect(endpoint.requests).toBeLessThanOrEqual(MAX_REQUESTS_TO_A_DOWN_ENDPOINT);
  }, 60_000);

  it.each([
    [400, "Invalid value for 'messages[0].role'."],
    [404, "The model `local-model` does not exist."],
  ])(
    "keeps an HTTP %i from a live endpoint terminal",
    async (status, message) => {
      const endpoint = await endpointAnswering(status, message);
      const { runtime, fallback } = await runtimeWithFallbackProvider(endpoint.baseURL);

      await expect(
        runtime.useModel(ModelType.TEXT_SMALL, { prompt: "Reply briefly." })
      ).rejects.toMatchObject({ statusCode: status });
      expect(fallback.calls).toBe(0);
      expect(endpoint.requests()).toBe(1);
    },
    60_000
  );

  it("keeps a caller abort terminal while the endpoint is down", async () => {
    const baseURL = `http://127.0.0.1:${await closedLoopbackPort()}/v1`;
    const caller = new AbortController();
    const realFetch = globalThis.fetch;
    // The caller cancels right after the first refused connection.
    const endpoint = countRequestsTo(baseURL, async (...args) => {
      try {
        return await realFetch(...args);
      } finally {
        caller.abort(new DOMException("caller cancelled the turn", "AbortError"));
      }
    });
    const { runtime, fallback } = await runtimeWithFallbackProvider(baseURL);

    await expect(
      runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: "Reply briefly.",
        signal: caller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError", message: "caller cancelled the turn" });
    expect(fallback.calls).toBe(0);
    expect(endpoint.requests).toBe(1);
  }, 60_000);
});
