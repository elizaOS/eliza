/**
 * Unit-tests the gateway's channel-side identity-link confirmation: code
 * extraction, the confirm call contract, negative-cache invalidation on
 * success, status-specific rejection replies, and hard failure on transport
 * errors. Deterministic — fetch and redis are injected fakes; no network.
 */
import { describe, expect, test } from "bun:test";
import { extractIdentityLinkCode } from "@elizaos/cloud-services-common/identity-link-code";
import { tryConfirmIdentityLink } from "../identity-link";

function makeDeps(response: Response) {
  const delCalls: string[] = [];
  const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const deps = {
    redis: {
      del: async (key: string) => {
        delCalls.push(key);
        return 1;
      },
    },
    cloudBaseUrl: "https://cloud.example",
    getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return response;
    }) as typeof fetch,
  };
  return { deps, delCalls, fetchCalls };
}

describe("extractIdentityLinkCode", () => {
  test("finds a prefixed code case-insensitively inside chat text", () => {
    expect(extractIdentityLinkCode("here: link-7kq2m4xw thanks")).toBe(
      "LINK-7KQ2M4XW",
    );
    expect(extractIdentityLinkCode("LINK-ABCDEFGH")).toBe("LINK-ABCDEFGH");
  });

  test("ignores ordinary onboarding messages and near-misses", () => {
    expect(extractIdentityLinkCode("hello, I want an agent")).toBeNull();
    expect(extractIdentityLinkCode("LINK-SHORT")).toBeNull();
    expect(extractIdentityLinkCode(undefined)).toBeNull();
  });
});

describe("tryConfirmIdentityLink", () => {
  test("passes through messages without a code untouched", async () => {
    const { deps, fetchCalls } = makeDeps(new Response("{}", { status: 200 }));
    const result = await tryConfirmIdentityLink(
      deps,
      "telegram",
      "1555",
      "Sam",
      "hi there",
    );
    expect(result.handled).toBe(false);
    expect(fetchCalls.length).toBe(0);
  });

  test("confirms a code, deletes the negative-cache entry, and replies linked", async () => {
    const ok = new Response(
      JSON.stringify({
        success: true,
        data: { status: "linked", userId: "u1" },
      }),
      { status: 200 },
    );
    const { deps, delCalls, fetchCalls } = makeDeps(ok);

    const result = await tryConfirmIdentityLink(
      deps,
      "telegram",
      "15551230001",
      "Sam",
      "LINK-7KQ2M4XW",
    );

    expect(result).toMatchObject({ handled: true, linked: true });
    expect(result.reply).toContain("linked");
    expect(delCalls).toEqual(["identity:telegram:15551230001"]);
    expect(fetchCalls[0].url).toBe(
      "https://cloud.example/api/eliza-app/identity-link/confirm",
    );
    expect(fetchCalls[0].body).toMatchObject({
      code: "LINK-7KQ2M4XW",
      platform: "telegram",
      platformId: "15551230001",
      platformName: "Sam",
    });
  });

  test("keeps the negative cache and replies with the specific rejection", async () => {
    const rejected = new Response(
      JSON.stringify({ success: false, data: { status: "already_used" } }),
      { status: 409 },
    );
    const { deps, delCalls } = makeDeps(rejected);

    const result = await tryConfirmIdentityLink(
      deps,
      "telegram",
      "424242",
      undefined,
      "LINK-ABCDEFGH",
    );

    expect(result).toMatchObject({ handled: true, linked: false });
    expect(result.reply).toContain("already used");
    expect(delCalls.length).toBe(0);
  });

  test("throws on gateway/cloud transport failure instead of faking a verdict", async () => {
    const { deps } = makeDeps(new Response("oops", { status: 500 }));
    await expect(
      tryConfirmIdentityLink(
        deps,
        "telegram",
        "1555",
        undefined,
        "LINK-ABCDEFGH",
      ),
    ).rejects.toThrow("identity-link confirm failed (500)");
  });
});
