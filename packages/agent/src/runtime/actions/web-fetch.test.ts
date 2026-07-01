import type {
  ActionParameters,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
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

  // SSRF block-path coverage (#10718). The allow-path tests above all use a
  // public IP literal, so a regression that deleted the literal-hostname block
  // list or the resolved-IP check in resolveUrlSafety (custom-actions.ts) would
  // NOT fail any of them — the classic SSRF payloads would silently start
  // reaching the network. These pin the block path: for each, the pinned fetch
  // is armed to THROW, so if the guard fails to block, the test fails loudly
  // (either the throw surfaces or a success result comes back) instead of the
  // expected "blocked host".
  describe("SSRF guard blocks internal/metadata/private targets", () => {
    // The pinned fetch is armed to SUCCEED, not throw, and we count its calls.
    // This is load-bearing: an earlier version threw here, but a thrown pinned
    // fetch produces a "blocked"-like result on its own, so the test passed even
    // when the guard was neutered (verified). Arming success means a guard
    // regression lets the request through → success → the assertions below fail.
    let pinnedCalls = 0;
    const armSuccessFetch = () => {
      pinnedCalls = 0;
      __setPinnedFetchImplForTests(async () => {
        pinnedCalls += 1;
        return new Response("SHOULD_NOT_REACH_INTERNAL_HOST", { status: 200 });
      });
    };

    const BLOCKED_HOSTS = [
      "https://localhost/data",
      "https://127.0.0.1/data",
      "https://[::1]/data",
      "https://0.0.0.0/data",
      "https://169.254.169.254/latest/meta-data/", // AWS link-local metadata
      "https://metadata.google.internal/computeMetadata/v1/", // GCP metadata
      "https://printer.local/admin", // mDNS .local
      "https://10.0.0.5/data", // RFC1918 private
      "https://192.168.1.1/data", // RFC1918 private
      "https://172.16.0.1/data", // RFC1918 private
    ];

    for (const url of BLOCKED_HOSTS) {
      it(`blocks ${url} without sending a request`, async () => {
        armSuccessFetch();
        const { result } = await runHandler({ url });
        // The request must never leave the guard.
        expect(pinnedCalls, `${url}: guard let the request through`).toBe(0);
        expect(result.success, `${url} should be blocked`).toBe(false);
        expect(result.text?.toLowerCase()).toContain("blocked host");
        expect(result.text).not.toContain("SHOULD_NOT_REACH_INTERNAL_HOST");
      });
    }

    it("blocks DNS rebinding — a public hostname that resolves to a private IP", async () => {
      // The hostname is public, but DNS returns an RFC1918 address; the
      // resolved-IP check must block it before the pinned request runs.
      __setDnsLookupImplForTests(async () => ["10.10.10.10"]);
      armSuccessFetch();
      const { result } = await runHandler({
        url: "https://totally-legit.example.test/data",
      });
      expect(pinnedCalls, "rebinding: guard let the request through").toBe(0);
      expect(result.success).toBe(false);
      expect(result.text?.toLowerCase()).toContain("blocked host");
    });
  });
});
