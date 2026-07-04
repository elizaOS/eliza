/**
 * Behavioral tests for the WEB_FETCH action: capability gating via
 * ELIZA_WEB_FETCH, SSRF/DNS safety, response-body capping, JSON-path
 * extraction, and User-Agent defaults. Deterministic — DNS resolution and the
 * pinned fetch are stubbed through the test seams, so no real network or DNS.
 */
import type {
  ActionParameters,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setDnsLookupImplForTests,
  __setPinnedFetchImplForTests,
} from "../custom-actions.ts";
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
    __setDnsLookupImplForTests(null);
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

  it("blocks malformed DNS records before they reach the pinned request", async () => {
    __setDnsLookupImplForTests(async () => [
      { address: undefined },
      { address: "" },
    ]);
    __setPinnedFetchImplForTests(async () => {
      throw new Error("pinned fetch should not run");
    });

    const { result } = await runHandler({
      url: "https://api.example.test/data",
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("blocked host");
    expect(result.text).not.toContain("Invalid IP address");
  });

  it("normalizes string DNS records before pinning the request", async () => {
    __setDnsLookupImplForTests(async () => ["93.184.216.34"]);
    __setPinnedFetchImplForTests(async ({ target }) => {
      expect(target.pinnedAddress).toBe("93.184.216.34");
      return new Response("ok", { status: 200 });
    });

    const { result } = await runHandler({
      url: "https://api.example.test/data",
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("ok");
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

describe("guarded WEB_FETCH User-Agent defaults", () => {
  const originalOperatorUserAgent = process.env.ELIZA_WEB_FETCH_USER_AGENT;

  afterEach(() => {
    if (originalOperatorUserAgent === undefined) {
      delete process.env.ELIZA_WEB_FETCH_USER_AGENT;
    } else {
      process.env.ELIZA_WEB_FETCH_USER_AGENT = originalOperatorUserAgent;
    }
    vi.resetModules();
  });

  async function loadGuardedFetchWithOperatorUserAgent(
    userAgent: string | undefined,
  ) {
    vi.resetModules();
    if (userAgent === undefined) {
      delete process.env.ELIZA_WEB_FETCH_USER_AGENT;
    } else {
      process.env.ELIZA_WEB_FETCH_USER_AGENT = userAgent;
    }
    return import("../custom-actions.ts");
  }

  async function captureGuardedFetchUserAgent(
    userAgent: string | undefined,
    url: string,
    headers?: Record<string, string>,
  ): Promise<string | null> {
    const customActions =
      await loadGuardedFetchWithOperatorUserAgent(userAgent);
    let capturedUserAgent: string | null = null;
    customActions.__setDnsLookupImplForTests(async () => ["93.184.216.34"]);
    customActions.__setPinnedFetchImplForTests(async ({ init }) => {
      capturedUserAgent = new Headers(init.headers).get("user-agent");
      return new Response("ok", { status: 200 });
    });

    try {
      const result = await customActions.performGuardedHttpGet(url, {
        headers,
      });
      expect(result.ok).toBe(true);
      return capturedUserAgent;
    } finally {
      customActions.__setPinnedFetchImplForTests(null);
      customActions.__setDnsLookupImplForTests(null);
    }
  }

  it("uses the CLI User-Agent for wttr.in, including trailing-dot FQDNs", async () => {
    await expect(
      captureGuardedFetchUserAgent(undefined, "https://wttr.in./London"),
    ).resolves.toBe("Eliza/1.0 (+https://elizaos.ai)");
  });

  it("honors the operator User-Agent override for wttr.in hosts", async () => {
    await expect(
      captureGuardedFetchUserAgent(
        "CorpProxyAllowlist/2026",
        "https://wttr.in/London",
      ),
    ).resolves.toBe("CorpProxyAllowlist/2026");
  });

  it("honors the operator User-Agent override for non-wttr.in hosts", async () => {
    await expect(
      captureGuardedFetchUserAgent(
        "CorpProxyAllowlist/2026",
        "https://api.example.test/data",
      ),
    ).resolves.toBe("CorpProxyAllowlist/2026");
  });

  it("keeps caller-supplied User-Agent headers above defaults", async () => {
    await expect(
      captureGuardedFetchUserAgent(
        "CorpProxyAllowlist/2026",
        "https://wttr.in/London",
        { "user-agent": "CallerUA/1.0" },
      ),
    ).resolves.toBe("CallerUA/1.0");
  });
});

describe("WEB_FETCH routing hint (#12209)", () => {
  it("states its planner boundary versus WEB_SEARCH, ATTACHMENT, and MEMORY", () => {
    const hint = webFetch.routingHint ?? "";
    expect(hint).toContain("WEB_FETCH");
    expect(hint).toContain("WEB_SEARCH");
    expect(hint).toContain("ATTACHMENT");
    expect(hint).toContain("MEMORY");
  });
});
