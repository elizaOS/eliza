import { describe, expect, test } from "bun:test";
import { getPlatformAgentCard } from "@/lib/api/a2a/platform-cloud";
import { executeCloudCapabilityRest } from "@/lib/cloud-capabilities";
import { listPlatformCloudMcpTools } from "@/lib/mcp/platform-cloud-tools";
import type { AppContext } from "@/types/cloud-worker-env";

function fakeContext(): AppContext {
  return {
    env: { NEXT_PUBLIC_APP_URL: "https://api.example.test" },
    req: { url: "https://api.example.test/api/a2a", header: () => undefined },
  } as unknown as AppContext;
}

describe("platform protocol surfaces", () => {
  test("platform MCP exposes generic API/admin tools plus capability tools", () => {
    const names = new Set(listPlatformCloudMcpTools().map((tool) => tool.name));

    expect(names.has("cloud.api.request")).toBe(true);
    expect(names.has("cloud.admin.request")).toBe(true);
    expect(names.has("cloud.billing.active_resources")).toBe(true);
    expect(names.has("cloud.billing.cancel_resource")).toBe(true);
    expect(names.has("cloud.credits.wallet_topup")).toBe(true);
  });

  test("platform A2A Agent Card advertises billing and admin skills", () => {
    const card = getPlatformAgentCard(fakeContext());
    const skillIds = new Set(card.skills.map((skill) => skill.id));

    expect(card.url).toBe("https://api.example.test/api/a2a");
    expect(skillIds.has("cloud.billing.active_resources")).toBe(true);
    expect(skillIds.has("cloud.billing.cancel_resource")).toBe(true);
    expect(skillIds.has("cloud.admin.users")).toBe(true);
  });

  test("capability REST executor invokes advertised REST routes", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const result = await executeCloudCapabilityRest(fakeContext(), "cloud.auth.wallet_nonce", {
        query: { chainId: 8453 },
      });

      expect(result.capability.id).toBe("auth.wallet_nonce");
      expect(result.request).toEqual({ method: "GET", path: "/api/auth/siwe/nonce" });
      expect(result.response).toMatchObject({ status: 200, ok: true, body: { ok: true } });
      expect(calls).toEqual([
        { url: "https://api.example.test/api/auth/siwe/nonce?chainId=8453", method: "GET" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
