import { describe, expect, test } from "bun:test";
import { GET } from "@/apps/api/v1/eliza/lifeops/github-complete/route";

function routeUrl(params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `https://example.com/api/v1/eliza/lifeops/github-complete?${search.toString()}`;
}

describe("lifeops github completion route", () => {
  test("returns an html handoff page for popup completion", async () => {
    const response = await GET(
      new Request(
        routeUrl({
          github_connected: "true",
          connection_id: "conn-1",
          post_message: "1",
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("agent-lifeops-github-complete");
    expect(html).toContain("LifeOps GitHub connected");
  });

  test("returns an html handoff page for deep-link completion", async () => {
    const response = await GET(
      new Request(
        routeUrl({
          github_connected: "true",
          connection_id: "conn-1",
          return_url: "agent://lifeops",
        }),
      ),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("agent://lifeops");
    expect(html).toContain("github_target=owner");
    expect(html).toContain("github_status=connected");
  });

  test("preserves agent callback metadata for client-side fallback linking", async () => {
    const response = await GET(
      new Request(
        routeUrl({
          github_connected: "true",
          connection_id: "conn-1",
          agent_id: "agent-123",
          target: "agent",
          post_message: "1",
        }),
      ),
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('"target":"agent"');
    expect(html).toContain('"agentId":"agent-123"');
    expect(html).toContain("Agent GitHub connected");
  });

  test("redirects back to the cloud dashboard when no local handoff is requested", async () => {
    const response = await GET(
      new Request(
        routeUrl({
          github_error: "denied",
        }),
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/dashboard/settings?tab=connections");
    expect(response.headers.get("location")).toContain("github_error=denied");
  });
});
