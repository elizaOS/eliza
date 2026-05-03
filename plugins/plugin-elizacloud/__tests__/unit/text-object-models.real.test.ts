import * as http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleObjectSmall } from "../../models/object";
import { handleTextSmall } from "../../models/text";

let server: http.Server;
let baseUrl: string;
let lastRequestBody = "";
let lastRequestHeaders: http.IncomingHttpHeaders = {};
let nextStatus = 200;
let nextBody = "{}";

function createRuntime(overrides: Record<string, string> = {}) {
  return {
    character: {
      system: overrides.SYSTEM_PROMPT,
    },
    getSetting(key: string) {
      if (key in overrides) {
        return overrides[key];
      }
      if (key === "ELIZAOS_CLOUD_API_KEY") {
        return "eliza_test_key";
      }
      if (key === "ELIZAOS_CLOUD_BASE_URL") {
        return baseUrl;
      }
      if (key === "SMALL_MODEL") {
        return "openai/gpt-5.4-mini";
      }
      return undefined;
    },
    emitEvent() {},
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      lastRequestBody = Buffer.concat(chunks).toString("utf8");
      lastRequestHeaders = req.headers;
      res.writeHead(nextStatus, { "Content-Type": "application/json" });
      res.end(nextBody);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  lastRequestBody = "";
  lastRequestHeaders = {};
  nextStatus = 200;
  nextBody = "{}";
});

describe("elizacloud responses-backed text/object models", () => {
  it("sends text generation requests to /responses with normalized input_text content", async () => {
    nextBody = JSON.stringify({
      output_text: "Hello from responses",
      usage: {
        input_tokens: 8,
        output_tokens: 4,
        total_tokens: 12,
      },
    });

    const text = await handleTextSmall(
      createRuntime({ SYSTEM_PROMPT: "You are concise." }) as never,
      {
        prompt: "Say hello",
        temperature: 0.2,
      } as never
    );

    const request = JSON.parse(lastRequestBody) as {
      input: Array<{
        role: string;
        content: Array<{ type: string; text: string }>;
      }>;
      temperature?: number;
    };

    expect(request.input).toEqual([
      {
        role: "system",
        content: [{ type: "input_text", text: "You are concise." }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: "Say hello" }],
      },
    ]);
    expect(request.temperature).toBeUndefined();
    expect(lastRequestHeaders["x-eliza-llm-purpose"]).toBe("response");
    expect(lastRequestHeaders["x-eliza-model-type"]).toBe("TEXT_SMALL");
    expect(text).toBe("Hello from responses");
  });

  it("recovers text from structured message output when output_text is omitted", async () => {
    nextBody = JSON.stringify({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "Hello from structured output",
            },
          ],
        },
      ],
    });

    const text = await handleTextSmall(
      createRuntime() as never,
      {
        prompt: "Say hello",
        temperature: 0.2,
      } as never
    );

    expect(text).toBe("Hello from structured output");
  });

  it("recovers text from top-level output_text items", async () => {
    nextBody = JSON.stringify({
      output: [
        {
          type: "output_text",
          text: "Hello from top-level output item",
        },
      ],
    });

    const text = await handleTextSmall(
      createRuntime() as never,
      {
        prompt: "Say hello",
        temperature: 0.2,
      } as never
    );

    expect(text).toBe("Hello from top-level output item");
  });

  it("recovers text from chat-completions style choices payloads", async () => {
    nextBody = JSON.stringify({
      choices: [
        {
          message: {
            content: [
              {
                type: "text",
                text: "Hello from choices payload",
              },
            ],
          },
        },
      ],
    });

    const text = await handleTextSmall(
      createRuntime() as never,
      {
        prompt: "Say hello",
        temperature: 0.2,
      } as never
    );

    expect(text).toBe("Hello from choices payload");
  });

  it("parses object generation responses from output_text JSON", async () => {
    nextBody = JSON.stringify({
      output_text: '{"status":"ok","count":2}',
      usage: {
        input_tokens: 9,
        output_tokens: 6,
        total_tokens: 15,
      },
    });

    const result = await handleObjectSmall(
      createRuntime() as never,
      {
        prompt: "Return a JSON object",
        temperature: 0,
      } as never
    );

    const request = JSON.parse(lastRequestBody) as {
      input: Array<{
        role: string;
        content: Array<{ type: string; text: string }>;
      }>;
    };

    expect(request.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "Return a JSON object" }],
      },
    ]);
    expect(result).toEqual({ status: "ok", count: 2 });
  });

  it("parses object generation responses from structured message output", async () => {
    nextBody = JSON.stringify({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: '{"status":"ok","count":3}',
            },
          ],
        },
      ],
    });

    const result = await handleObjectSmall(
      createRuntime() as never,
      {
        prompt: "Return a JSON object",
        temperature: 0,
      } as never
    );

    expect(result).toEqual({ status: "ok", count: 3 });
  });
});
