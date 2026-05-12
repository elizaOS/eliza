import { describe, expect, it } from "bun:test";
import { applyCorsHeaders, getCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";

describe("proxy CORS helpers", () => {
  it("allows service-key and Agent client headers for direct browser calls", () => {
    const headers = getCorsHeaders("GET, POST, OPTIONS");
    expect(headers["Access-Control-Allow-Headers"]).toContain("X-Service-Key");
    expect(headers["Access-Control-Allow-Headers"]).toContain("X-Agent-Client-Id");
  });

  it("returns wildcard preflight responses", () => {
    const response = handleCorsOptions("GET, OPTIONS");
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("applies CORS headers to an existing response", async () => {
    const response = applyCorsHeaders(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      "POST, OPTIONS",
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect((await response.json()) as { ok: boolean }).toEqual({ ok: true });
  });
});
