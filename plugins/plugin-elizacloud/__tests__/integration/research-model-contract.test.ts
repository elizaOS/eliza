/**
 * Deterministic contract tests for handleResearch — a loopback HTTP double
 * plays the cloud /responses endpoint with controlled payloads.
 *
 * This is NOT live-cloud coverage. It was formerly misnamed
 * `research-model.real.test.ts`, which parked a stub-backed test in the
 * live-API `*.real.test.ts` lane. Live coverage lives in the post-merge real lane (`TEST_LANE=post-merge`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import * as http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleResearch } from "../../src/models/research";

interface HeldRequest {
  req: IncomingMessage;
  res: ServerResponse;
}

let server: http.Server;
let baseUrl: string;
let lastRequestBody = "";
let nextStatus = 200;
let nextBody = "{}";
let holdResponse = false;
const heldRequests: HeldRequest[] = [];

function releaseHeldRequests(): void {
  while (heldRequests.length > 0) {
    const held = heldRequests.pop();
    if (!held) {
      continue;
    }
    if (!held.res.writableEnded) {
      held.res.writeHead(499, { "Content-Type": "application/json" });
      held.res.end(JSON.stringify({ error: "client closed request" }));
    }
    held.req.destroy();
  }
}

function removeHeldRequest(req: IncomingMessage): void {
  const index = heldRequests.findIndex((held) => held.req === req);
  if (index >= 0) {
    heldRequests.splice(index, 1);
  }
}

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
      if (holdResponse) {
        heldRequests.push({ req, res });
        req.on("close", () => {
          removeHeldRequest(req);
        });
        return;
      }
      res.writeHead(nextStatus, { "Content-Type": "application/json" });
      res.end(nextBody);
    });
    req.on("aborted", () => {
      removeHeldRequest(req);
      if (!res.writableEnded) {
        res.destroy();
      }
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

afterAll(async () => {
  releaseHeldRequests();
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

beforeEach(() => {
  nextStatus = 200;
  nextBody = "{}";
  holdResponse = false;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  releaseHeldRequests();
  holdResponse = false;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(heldRequests).toHaveLength(0);
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

  it("aborts the in-flight cloud request when the caller cancels", async () => {
    holdResponse = true;
    const controller = new AbortController();
    const request = handleResearch(createRuntime() as never, {
      input: "Research cancellation behavior.",
      signal: controller.signal,
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    controller.abort(new DOMException("Research cancelled", "AbortError"));

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(heldRequests).toHaveLength(0);
  });

  it("retains the configured cloud timeout when no caller signal fires", async () => {
    holdResponse = true;
    vi.stubEnv("ELIZAOS_CLOUD_RESEARCH_TIMEOUT_MS", "5");

    const request = handleResearch(createRuntime() as never, {
      input: "Research timeout behavior.",
    });

    await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(heldRequests).toHaveLength(0);
  });
});
