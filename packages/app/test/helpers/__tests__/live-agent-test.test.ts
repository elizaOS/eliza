/** Exercises the provider fixture through a real runtime and OpenAI handler against a loopback HTTP endpoint. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ModelType } from "@elizaos/core";
import { expect, it, onTestFinished, vi } from "vitest";
import { buildLiveHarness } from "../live-agent-test";

it("loads the workspace provider and carries a complete model request and response", async () => {
  const requests: { url: string | undefined; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ url: request.url, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "fixture-response",
          object: "chat.completion",
          created: 1,
          model: "fixture-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "fixture reply" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    vi.unstubAllEnvs();
  });
  const { port } = server.address() as AddressInfo;
  vi.stubEnv("OPENAI_API_KEY", "fixture-key");
  vi.stubEnv("OPENAI_BASE_URL", `http://127.0.0.1:${port}/v1`);
  vi.stubEnv("OPENAI_SMALL_MODEL", "fixture-model");
  const harness = await buildLiveHarness({
    provider: "openai",
    requiredEnv: [],
  });
  onTestFinished(harness.close);

  const prompt = "Keep this entire request: alpha\nβeta\nfinal sentinel.";
  expect(await harness.runtime.useModel(ModelType.TEXT_SMALL, { prompt })).toBe(
    "fixture reply",
  );
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("/v1/chat/completions");
  expect(JSON.parse(requests[0].body)).toMatchObject({
    model: "fixture-model",
    messages: expect.arrayContaining([{ role: "user", content: prompt }]),
  });
});
