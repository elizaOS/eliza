import { describe, expect, test } from "bun:test";

import { GET as connectionSuccessGet } from "@/apps/api/eliza-app/auth/connection-success/route";

// The route is a Hono app mounted at "/" — pass a root-path URL so the router
// can match it. The real Next.js runtime strips the route prefix before calling
// the handler; tests must do the same.

describe("connection success route", () => {
  test("redirects web connections back to dashboard chat", async () => {
    const response = await connectionSuccessGet(new Request("https://elizacloud.ai/?platform=web"));

    // Hono's c.redirect() defaults to 302.
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://elizacloud.ai/dashboard/chat");
  });

  test("renders a platform-specific success page for messaging channels", async () => {
    const response = await connectionSuccessGet(
      new Request("https://elizacloud.ai/?platform=telegram"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");

    const body = await response.text();
    expect(body).toContain("you're connected.");
    expect(body).toContain("head back to Telegram and send me a message.");
  });

  test("renders popup-safe success page for Eliza App OAuth completions", async () => {
    const response = await connectionSuccessGet(
      new Request("https://elizacloud.ai/?source=eliza-app&platform=google&connection_id=conn-123"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");

    const body = await response.text();
    expect(body).toContain("Google connected.");
    expect(body).toContain("eliza-app-oauth-complete");
    expect(body).toContain("conn-123");
  });
});
