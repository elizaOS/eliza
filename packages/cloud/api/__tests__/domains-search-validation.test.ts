import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock();
const searchDomains = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/cloudflare-registrar", () => ({
  cloudflareRegistrarService: { searchDomains },
}));

const { default: searchRoute } = await import("../v1/domains/search/route");

const app = new Hono();
app.route("/api/v1/domains/search", searchRoute);

function search(body: string): Response | Promise<Response> {
  return app.request("/api/v1/domains/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("POST /api/v1/domains/search validation", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockReset();
    requireUserOrApiKeyWithOrg.mockResolvedValue({ organization_id: "org-1" });
    searchDomains.mockReset();
    searchDomains.mockResolvedValue([]);
  });

  for (const [name, query] of [
    ["spaces", "   "],
    ["tabs", "\t\t"],
    ["newlines", "\n\r\n"],
    ["mixed whitespace", " \t\r\n "],
  ] as const) {
    test(`rejects ${name} without calling the registrar`, async () => {
      const response = await search(JSON.stringify({ query }));

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ success: false });
      expect(searchDomains).not.toHaveBeenCalled();
    });
  }

  test("forwards a padded valid query after trimming", async () => {
    const response = await search(
      JSON.stringify({ query: "  example  ", limit: 7 }),
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({
      success: true,
      query: "example",
      candidates: [],
    });
    expect(searchDomains).toHaveBeenCalledTimes(1);
    expect(searchDomains).toHaveBeenCalledWith("example", 7);
  });

  test("rejects malformed JSON with a typed 400 without calling the registrar", async () => {
    const response = await search("{");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false });
    expect(searchDomains).not.toHaveBeenCalled();
  });

  test("preserves registrar failure handling", async () => {
    searchDomains.mockRejectedValueOnce(new Error("registrar unavailable"));

    const response = await search(JSON.stringify({ query: "example" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false });
    expect(searchDomains).toHaveBeenCalledTimes(1);
  });
});
