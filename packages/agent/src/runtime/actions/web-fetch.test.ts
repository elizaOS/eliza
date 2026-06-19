import type {
  ActionParameters,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { __setPinnedFetchImplForTests } from "../custom-actions.ts";
import { webFetch } from "./web-fetch.ts";

// Use a public IP literal so resolveUrlSafety skips DNS and goes straight to
// the pinned-fetch impl, which we mock — no real network, no DNS.
const TEST_URL = "https://93.184.216.34/data";

async function runHandler(
  parameters: ActionParameters,
): Promise<{ result: ActionResult; captured: { text?: string } }> {
  const captured: { text?: string } = {};
  const result = await webFetch.handler(
    {} as IAgentRuntime,
    {} as Memory,
    {} as State,
    { parameters },
    (content) => {
      captured.text = content.text;
      return Promise.resolve([]);
    },
  );
  if (!result) throw new Error("handler returned no result");
  return { result, captured };
}

describe("WEB_FETCH action", () => {
  const originalWebFetchEnv = process.env.ELIZA_WEB_FETCH;

  afterEach(() => {
    __setPinnedFetchImplForTests(null);
    if (originalWebFetchEnv === undefined) {
      delete process.env.ELIZA_WEB_FETCH;
    } else {
      process.env.ELIZA_WEB_FETCH = originalWebFetchEnv;
    }
  });

  it("is available by default (no key/service required)", async () => {
    delete process.env.ELIZA_WEB_FETCH;
    expect(await webFetch.validate({} as IAgentRuntime, {} as Memory)).toBe(
      true,
    );
  });

  it("is gated off when ELIZA_WEB_FETCH disables the capability", async () => {
    for (const value of ["0", "false", "off"]) {
      process.env.ELIZA_WEB_FETCH = value;
      expect(await webFetch.validate({} as IAgentRuntime, {} as Memory)).toBe(
        false,
      );
    }
  });

  it("returns the fetched text snippet and fires the callback", async () => {
    __setPinnedFetchImplForTests(
      async () => new Response("hello world", { status: 200 }),
    );

    const { result, captured } = await runHandler({ url: TEST_URL });

    expect(result.success).toBe(true);
    expect(result.text).toBe("hello world");
    expect(captured.text).toBe("hello world");
    expect(result.data).toMatchObject({
      actionName: "WEB_FETCH",
      url: TEST_URL,
      value: "hello world",
    });
  });

  it("caps an oversized response body (streaming read, not full buffer)", async () => {
    // Body far larger than the 4 000-char snippet cap. The guarded reader
    // stops streaming once the cap is reached rather than buffering all of it.
    const huge = "x".repeat(50_000);
    __setPinnedFetchImplForTests(
      async () => new Response(huge, { status: 200 }),
    );

    const { result } = await runHandler({ url: TEST_URL });

    expect(result.success).toBe(true);
    expect(result.text).toBeDefined();
    expect((result.text ?? "").length).toBe(4_000);
  });

  it("extracts a JSON path when extract is provided", async () => {
    __setPinnedFetchImplForTests(
      async () =>
        new Response(JSON.stringify({ data: { price: 42 } }), { status: 200 }),
    );

    const { result } = await runHandler({
      url: TEST_URL,
      extract: "data.price",
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("42");
  });

  it("fails honestly on a non-2xx status", async () => {
    __setPinnedFetchImplForTests(
      async () => new Response("nope", { status: 503 }),
    );

    const { result } = await runHandler({ url: TEST_URL });

    expect(result.success).toBe(false);
    expect(result.text).toContain("503");
  });

  it("blocks non-https URLs without sending a request", async () => {
    const { result } = await runHandler({ url: "http://example.com/" });
    expect(result.success).toBe(false);
    expect(result.text).toContain("https");
  });

  it("requires a url parameter", async () => {
    const { result } = await runHandler({});
    expect(result.success).toBe(false);
    expect(result.text).toContain("url");
  });
});
