/**
 * Exercises activation's provider health check through the real runtime, model
 * adapter and HTTP SDK against a deterministic loopback provider. A provider
 * requiring several output tokens must complete without a probe-imposed limit;
 * genuinely incomplete output and rejected credentials still block activation.
 */
import { createServer } from "node:http";
import { AgentRuntime, ModelType } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { handleTextSmall } from "../../../../../plugins/plugin-openai/models/text";
import { InMemoryDatabaseAdapter } from "../../../../core/src/database/inMemoryAdapter";
import { providerSmokeCheck } from "./health-checks";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["complete", "length", "unauthorized"] as const)(
  "checks provider activation through the HTTP adapter: %s",
  async (outcome) => {
    let requests = 0;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests += 1;
        if (outcome === "unauthorized") {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: "Invalid API key",
                type: "authentication_error",
              },
            }),
          );
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          max_tokens?: number;
          max_completion_tokens?: number;
        };
        const budget = body.max_completion_tokens ?? body.max_tokens;
        const incomplete =
          outcome === "length" || (budget !== undefined && budget < 4);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "health-wire",
            object: "chat.completion",
            created: 1,
            model: "gpt-4o-mini",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: incomplete ? "" : "pong",
                },
                finish_reason: incomplete ? "length" : "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing loopback address");
      const originalFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        if (url.hostname !== "127.0.0.1" || url.port !== String(address.port)) {
          throw new Error("Provider test forbids external requests");
        }
        return originalFetch(input, init);
      });
      vi.stubEnv("ELIZA_PROVIDER", "openai");
      vi.stubEnv("CEREBRAS_API_KEY", undefined);
      vi.stubEnv("OPENAI_API_KEY", "loopback-test-key");
      vi.stubEnv("OPENAI_BASE_URL", `http://127.0.0.1:${address.port}/v1`);
      vi.stubEnv("OPENAI_SMALL_MODEL", "gpt-4o-mini");
      const runtime = new AgentRuntime({
        character: { name: "HealthWire", bio: ["test"] },
        logLevel: "fatal",
        adapter: new InMemoryDatabaseAdapter(),
      });
      runtime.registerModel(
        ModelType.TEXT_SMALL,
        handleTextSmall,
        "openai",
        100,
      );
      const result = await providerSmokeCheck.run(runtime);
      expect(requests).toBe(1);
      if (outcome === "complete") {
        expect(result).toEqual({ ok: true });
      } else {
        expect(result.ok).toBe(false);
        if (result.ok)
          throw new Error("Invalid provider output passed activation");
        expect(result.reason).toContain(
          outcome === "length"
            ? "did not complete successfully (length)"
            : "Invalid API key",
        );
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
