/**
 * Provider failover when the OpenAI-compatible endpoint is down. The AI SDK
 * reports a refused connection as an APICallError ("Cannot connect to API")
 * that keeps the socket error on `.cause`, so useModel must still try the next
 * TEXT_SMALL provider. Real closed loopback port under Node; the Bun case
 * replays the rejection Bun's fetch raises for the same port.
 */
import { createServer } from "node:net";
import { ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTextSmall } from "../models/text";

const runtimes: Array<ReturnType<typeof createSQLiteTestRuntime>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
    await runtime.close();
  }
});

/** A loopback port with nothing listening: the provider process is down. */
async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
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
  runtime.registerModel(ModelType.TEXT_SMALL, handleTextSmall, "openai", 100);
  runtime.registerModel(
    ModelType.TEXT_SMALL,
    async () => "answer from the fallback provider",
    "fallback-provider",
    1
  );
  return runtime;
}

describe("TEXT_SMALL failover when the OpenAI-compatible endpoint is down", () => {
  it("tries the next provider after Node's ECONNREFUSED", async () => {
    const realFetch = globalThis.fetch;
    let attempts = 0;
    vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
      attempts += 1;
      return realFetch(...args);
    });
    const runtime = await runtimeWithFallbackProvider(
      `http://127.0.0.1:${await closedLoopbackPort()}/v1`
    );

    await expect(
      runtime.useModel(ModelType.TEXT_SMALL, { prompt: "Reply briefly." })
    ).resolves.toBe("answer from the fallback provider");
    expect(attempts).toBeGreaterThan(0);
  }, 60_000);

  it("tries the next provider after Bun's ConnectionRefused", async () => {
    const baseURL = `http://127.0.0.1:${await closedLoopbackPort()}/v1`;
    let attempts = 0;
    // Bun 1.4 rejects fetch to a closed port with this TypeError (no cause),
    // where Node raises `fetch failed` with an ECONNREFUSED cause.
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
      attempts += 1;
      throw Object.assign(
        new TypeError("Unable to connect. Is the computer able to access the url?"),
        { code: "ConnectionRefused", path: String(input), errno: 0 }
      );
    });
    const runtime = await runtimeWithFallbackProvider(baseURL);

    await expect(
      runtime.useModel(ModelType.TEXT_SMALL, { prompt: "Reply briefly." })
    ).resolves.toBe("answer from the fallback provider");
    expect(attempts).toBeGreaterThan(0);
  }, 60_000);
});
