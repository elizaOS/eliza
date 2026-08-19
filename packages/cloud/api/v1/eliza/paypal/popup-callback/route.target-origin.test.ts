/** Exercises PayPal popup target-origin validation through the real route HTML. */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import route from "./route";

const app = new Hono<AppEnv>().route("/callback", route);

async function render(configuredOrigin?: string): Promise<string> {
  const response = await app.request("/callback?code=secret&state=state", {}, {
    AGENT_APP_ORIGIN: configuredOrigin,
  } as AppEnv["Bindings"]);
  expect(response.status).toBe(200);
  return response.text();
}

describe("PayPal popup target origin", () => {
  test("canonicalizes the configured URL to its exact origin", async () => {
    const html = await render("https://app.eliza.how/some/path?query=1");
    expect(html).toContain("var targetOrigin = 'https://app.eliza.how';");
    expect(html).not.toContain("some/path");
  });

  test.each([undefined, "", "*", "data:text/html,opaque", "not a URL"])(
    "fails closed for configured origin %p",
    async (configuredOrigin) => {
      const html = await render(configuredOrigin);
      expect(html).toContain("var targetOrigin = '';");
      expect(html).toContain("if (targetOrigin && window.opener");
    },
  );
});
