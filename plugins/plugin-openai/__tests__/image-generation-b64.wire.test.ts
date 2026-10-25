import { createServer, type Server } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleImageGeneration } from "../models/image";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let server: Server;
let baseUrl: string;
let responseBody: unknown;
let requestBodies: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requestBodies.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody));
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
  requestBodies = [];
  vi.stubEnv("ELIZA_PROVIDER", undefined);
  vi.stubEnv("OPENAI_BASE_URL", baseUrl);
  vi.stubEnv("OPENAI_API_KEY", "loopback-only-key");
  vi.stubEnv("ELIZA_MOCK_OPENAI_BASE", undefined);
  vi.stubEnv("ELIZA_TRAJECTORY_STRICT", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function runtime(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
    character: { name: "Ada" },
    emitEvent: async () => {},
    getService: () => null,
    getServicesByType: () => [],
  } as unknown as IAgentRuntime;
}

describe("OpenAI image generation response decoding", () => {
  it("returns the image bytes when the Images API answers with b64_json only", async () => {
    responseBody = {
      created: 1760140800,
      background: "opaque",
      data: [{ b64_json: PNG_1X1_BASE64 }],
      output_format: "png",
      quality: "medium",
      size: "1024x1024",
      usage: {
        input_tokens: 12,
        input_tokens_details: { image_tokens: 0, text_tokens: 12 },
        output_tokens: 1056,
        total_tokens: 1068,
      },
    };

    const images = await handleImageGeneration(runtime({ OPENAI_IMAGE_MODEL: "gpt-image-1" }), {
      prompt: "a red square",
      count: 1,
    });

    expect(requestBodies[0]?.model).toBe("gpt-image-1");
    expect(images).toEqual([
      { url: `data:image/png;base64,${PNG_1X1_BASE64}`, revisedPrompt: undefined },
    ]);
  });

  it("uses the reported output format for the data URL media type", async () => {
    responseBody = {
      created: 1760140800,
      data: [{ b64_json: PNG_1X1_BASE64 }],
      output_format: "webp",
    };

    const images = await handleImageGeneration(runtime({ OPENAI_IMAGE_MODEL: "gpt-image-1" }), {
      prompt: "a red square",
    });

    expect(images).toEqual([
      { url: `data:image/webp;base64,${PNG_1X1_BASE64}`, revisedPrompt: undefined },
    ]);
  });

  it("keeps hosted URLs returned by dall-e-3", async () => {
    responseBody = {
      created: 1760140800,
      data: [
        {
          url: "https://oaidalleapiprodscus.blob.core.windows.net/private/img-abc.png",
          revised_prompt: "A vivid red square",
        },
      ],
    };

    const images = await handleImageGeneration(runtime({}), { prompt: "a red square" });

    expect(images).toEqual([
      {
        url: "https://oaidalleapiprodscus.blob.core.windows.net/private/img-abc.png",
        revisedPrompt: "A vivid red square",
      },
    ]);
  });

  it("rejects an image entry that carries neither a URL nor bytes", async () => {
    responseBody = { created: 1760140800, data: [{}] };

    await expect(
      handleImageGeneration(runtime({ OPENAI_IMAGE_MODEL: "gpt-image-1" }), {
        prompt: "a red square",
      })
    ).rejects.toThrow("OpenAI API returned an image without a URL or b64_json data");
  });
});
