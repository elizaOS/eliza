import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleResearch } from "../../src/models/research";

let server: http.Server;
let baseUrl: string;
let lastRequestBody = "";
let nextStatus = 200;
let nextBody = "{}";

function createRuntime(overrides: Record<string, string> = {}) {
  return {
    character: {},
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

describe("handleResearch", () => {
  it("normalizes string input into Responses API message content", async () => {
    nextStatus = 200;
    nextBody = JSON.stringify({
      id: "resp_123",
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "Research complete.",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://playwright.dev/docs/browsers",
                  title: "Playwright browsers",
                  start_index: 0,
                  end_index: 18,
                },
              ],
            },
          ],
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
    });

    const result = await handleResearch(createRuntime() as never, {
      input: "Research Playwright browser support.",
      tools: [{ type: "web_search_preview" }],
    });

    const request = JSON.parse(lastRequestBody) as {
      input: Array<{
        role: string;
        content: Array<{ type: string; text: string }>;
      }>;
    };

    expect(request.input).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Research Playwright browser support.",
          },
        ],
      },
    ]);
    expect(result.text).toBe("Research complete.");
    expect(result.annotations).toEqual([
      {
        url: "https://playwright.dev/docs/browsers",
        title: "Playwright browsers",
        startIndex: 0,
        endIndex: 18,
      },
    ]);
  });

  it("surfaces the provider tool limitation explicitly", async () => {
    nextStatus = 400;
    nextBody = JSON.stringify({
      error: {
        message: 'Invalid input: expected "function"',
        param: "tools.0.type",
        code: "invalid_request_error",
      },
    });

    await expect(
      handleResearch(createRuntime() as never, {
        input: "Research Playwright browser support.",
        tools: [{ type: "web_search_preview" }],
      })
    ).rejects.toThrow(
      "Eliza Cloud /responses rejected deep-research tool types; the provider currently only accepts function tools on this route"
    );
  });
});
