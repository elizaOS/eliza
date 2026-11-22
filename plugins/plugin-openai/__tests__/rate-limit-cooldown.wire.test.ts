/**
 * Exercises shared cooldowns through real text handlers, AI SDK and HTTP client.
 * A loopback provider rejects requests with a long Retry-After; request counts
 * prove fallback aliases do not resend a model before its window resets.
 */
import { createServer, type Server } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleResponseHandler, handleTextSmall } from "../models/text";

let server: Server;
let baseUrl: string;
let requests = 0;
let permanent = false;

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests++;
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "60",
      });
      response.end(
        JSON.stringify({
          error: {
            message: "Tokens per minute limit exceeded",
            ...(permanent ? { code: "insufficient_quota" } : {}),
          },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

beforeEach(() => {
  requests = 0;
  permanent = false;
  vi.stubEnv("ELIZA_PROVIDER", "cerebras");
  vi.stubEnv("OPENAI_BASE_URL", baseUrl);
  vi.stubEnv("OPENAI_API_KEY", "loopback-only-key");
  vi.stubEnv("CEREBRAS_API_KEY", undefined);
  vi.stubEnv("ELIZA_PLANNER_FULL_ACTION_SURFACE", undefined);
  vi.stubEnv("ELIZA_TRAJECTORY_STRICT", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function runtime(): IAgentRuntime {
  return {
    getSetting: () => undefined,
    character: { name: "Ada", system: "Reply to the user." },
    emitEvent: async () => {},
    getService: () => null,
    getServicesByType: () => [],
  } as unknown as IAgentRuntime;
}

async function consume(request: ReturnType<typeof handleTextSmall>): Promise<void> {
  const result = await request;
  if (typeof result === "string") throw new Error("expected provider failure");
  for await (const chunk of result.textStream) {
    throw new Error(`unexpected output before HTTP rejection: ${chunk}`);
  }
}

describe("rate-limit cooldown at the HTTP boundary", () => {
  it("does not turn permanent credit exhaustion into a temporary cooldown", async () => {
    permanent = true;
    const agent = runtime();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        handleTextSmall(agent, { prompt: "Probe", model: "qwen-3.8-27b", stream: false })
      ).rejects.toMatchObject({ statusCode: 429 });
      expect(requests).toBe(attempt + 1);
    }
  });

  it("preserves each credential's hold when A/B calls share an endpoint and model", async () => {
    const agent = runtime();
    const invoke = (credential: string) => {
      vi.stubEnv("OPENAI_API_KEY", credential);
      return handleTextSmall(agent, {
        prompt: "Complete shared-endpoint credential isolation probe",
        model: "qwen-3.8-27b",
        stream: false,
      });
    };
    await expect(invoke("credential-A-fixture")).rejects.toMatchObject({ statusCode: 429 });
    await expect(invoke("credential-B-fixture")).rejects.toMatchObject({ statusCode: 429 });
    expect(requests).toBe(2);
    await expect(invoke("credential-A-fixture")).rejects.toMatchObject({
      name: "ProviderRateLimitCooldownError",
      statusCode: 429,
    });
    await expect(invoke("credential-B-fixture")).rejects.toMatchObject({
      name: "ProviderRateLimitCooldownError",
      statusCode: 429,
    });
    expect(requests).toBe(2);
  });

  it.each([
    { firstStream: true, nextStream: true },
    { firstStream: true, nextStream: false },
    { firstStream: false, nextStream: true },
    { firstStream: false, nextStream: false },
  ])(
    "shares cooldown across aliases: $firstStream → $nextStream",
    async ({ firstStream, nextStream }) => {
      const agent = runtime();
      await expect(
        consume(
          handleResponseHandler(agent, {
            prompt: "First attempt",
            model: "qwen-3.8-27b",
            stream: firstStream,
          })
        )
      ).rejects.toMatchObject({ statusCode: 429 });
      expect(requests).toBe(1);

      await expect(
        consume(
          handleTextSmall(agent, {
            prompt: "Fallback attempt",
            model: "qwen-3.8-27b",
            stream: nextStream,
          })
        )
      ).rejects.toMatchObject({ name: "ProviderRateLimitCooldownError", statusCode: 429 });
      expect(requests).toBe(1);
    }
  );

  it("does not block another model or runtime, and retries after expiry", async () => {
    const agent = runtime();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const invoke = (owner: IAgentRuntime, model: string) =>
      consume(
        handleTextSmall(owner, {
          prompt: "Probe",
          model,
          stream: true,
        })
      );
    await expect(invoke(agent, "qwen-3.8-27b")).rejects.toMatchObject({ statusCode: 429 });
    await expect(invoke(agent, "qwen-3.8-27b")).rejects.toMatchObject({
      name: "ProviderRateLimitCooldownError",
    });
    expect(requests).toBe(1);
    await expect(invoke(agent, "another-model")).rejects.toMatchObject({ statusCode: 429 });
    await expect(invoke(runtime(), "qwen-3.8-27b")).rejects.toMatchObject({ statusCode: 429 });
    expect(requests).toBe(3);
    clock.mockReturnValue(now + 60_001);
    await expect(invoke(agent, "qwen-3.8-27b")).rejects.toMatchObject({ statusCode: 429 });
    expect(requests).toBe(4);
  });

  // Measured on Cerebras, whose per-minute allowance refills all the time: three
  // requests refused with Retry-After 59 were admitted 5, 14 and 27 seconds
  // later, re-sent each second. A host that knows this caps the hold.
  it.each(["OPENAI_RATE_LIMIT_MAX_HOLD_SECONDS", "CEREBRAS_RATE_LIMIT_MAX_HOLD_SECONDS"])(
    "holds a model no longer than the host's %s",
    async (setting) => {
      vi.stubEnv(setting, "5");
      const agent = runtime();
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const invoke = () =>
        handleTextSmall(agent, { prompt: "Probe", model: "qwen-3.8-27b", stream: false });
      await expect(invoke()).rejects.toMatchObject({ statusCode: 429 });
      clock.mockReturnValue(now + 4_999);
      await expect(invoke()).rejects.toMatchObject({ name: "ProviderRateLimitCooldownError" });
      expect(requests).toBe(1);
      // The provider said 60 seconds; the request goes out again after five.
      clock.mockReturnValue(now + 5_001);
      await expect(invoke()).rejects.toMatchObject({ statusCode: 429 });
      expect(requests).toBe(2);
    }
  );

  it.each(["", "soon", "0", "-5"])(
    "keeps the provider's whole delay when the cap is %j",
    async (value) => {
      vi.stubEnv("OPENAI_RATE_LIMIT_MAX_HOLD_SECONDS", value);
      const agent = runtime();
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const invoke = () =>
        handleTextSmall(agent, { prompt: "Probe", model: "qwen-3.8-27b", stream: false });
      await expect(invoke()).rejects.toMatchObject({ statusCode: 429 });
      clock.mockReturnValue(now + 59_000);
      await expect(invoke()).rejects.toMatchObject({ name: "ProviderRateLimitCooldownError" });
      expect(requests).toBe(1);
    }
  );

  it("never holds a model longer than the provider asked", async () => {
    vi.stubEnv("OPENAI_RATE_LIMIT_MAX_HOLD_SECONDS", "600");
    const agent = runtime();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const invoke = () =>
      handleTextSmall(agent, { prompt: "Probe", model: "qwen-3.8-27b", stream: false });
    await expect(invoke()).rejects.toMatchObject({ statusCode: 429 });
    clock.mockReturnValue(now + 60_001);
    await expect(invoke()).rejects.toMatchObject({ statusCode: 429 });
    expect(requests).toBe(2);
  });
});
