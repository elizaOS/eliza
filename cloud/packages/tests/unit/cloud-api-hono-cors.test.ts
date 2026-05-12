import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { corsMiddleware } from "@/lib/cors/cloud-api-hono-cors";

function createCorsTestApp() {
  const app = new Hono();
  app.use("*", corsMiddleware);
  app.get("/api/v1/eliza/agents", (c) => c.json({ agents: [] }));
  return app;
}

describe("Cloud API Hono CORS", () => {
  it("allows the Eliza homepage to call Cloud APIs", async () => {
    const app = createCorsTestApp();
    const response = await app.request("https://www.elizacloud.ai/api/v1/eliza/agents", {
      method: "OPTIONS",
      headers: {
        Origin: "https://eliza.ai",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://eliza.ai");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("omits allow-origin for unknown browser origins", async () => {
    const app = createCorsTestApp();
    const response = await app.request("https://www.elizacloud.ai/api/v1/eliza/agents", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "GET",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
