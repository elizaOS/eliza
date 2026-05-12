import { describe, expect, test } from "bun:test";

import { GET, OPTIONS } from "@/apps/api/openapi.json/route";
import { discoverPublicApiRoutes } from "@/lib/docs/api-route-discovery";
import { API_ENDPOINTS } from "@/lib/swagger/endpoint-discovery";

describe("Public API catalog", () => {
  test(
    "route discovery includes every documented endpoint",
    async () => {
      const routes = await discoverPublicApiRoutes();
      const implemented = new Set<string>();

      for (const route of routes) {
        for (const method of route.methods) {
          implemented.add(`${method} ${route.path}`);
        }
      }

      for (const endpoint of API_ENDPOINTS) {
        expect(implemented.has(`${endpoint.method} ${endpoint.path}`)).toBe(true);
      }
    },
    { timeout: 15_000 },
  );

  test("openapi.json includes every documented endpoint and method", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("max-age=3600");

    const body = await response.json();

    expect(body.info?.title).toBe("Eliza Cloud API");
    expect(body.info?.contact?.url).toMatch(/^https:\/\/www\.(dev\.)?elizacloud\.ai$/);
    expect(body.servers?.[0]?.url).toMatch(/^https:\/\/www\.(dev\.)?elizacloud\.ai$/);

    for (const endpoint of API_ENDPOINTS) {
      expect(body.paths[endpoint.path]?.[endpoint.method.toLowerCase()]).toBeDefined();
    }

    expect(body.paths["/api/elevenlabs/tts"]?.post).toBeDefined();
    expect(body.paths["/api/v1/user"]?.get).toBeDefined();
    expect(body.paths["/api/v1/user"]?.patch).toBeDefined();
  });

  test("openapi.json OPTIONS exposes CORS preflight headers", async () => {
    const response = await OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });
});
