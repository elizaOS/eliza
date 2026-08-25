/**
 * Pins the deploy-time Durable Object binding for X refresh coordination in
 * local, staging, and production Worker environments.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const wrangler = readFileSync(
  new URL("../wrangler.toml", import.meta.url),
  "utf8",
);

describe("X OAuth refresh coordinator deployment contract", () => {
  test("binds one coordinator namespace in every Worker environment", () => {
    expect(
      wrangler.match(/name = "TWITTER_OAUTH_REFRESH_COORDINATORS"/g),
    ).toHaveLength(3);
    expect(
      wrangler.match(/class_name = "TwitterOAuthRefreshCoordinator"/g),
    ).toHaveLength(3);
  });

  test("declares the Durable Object class export", () => {
    const config = Bun.TOML.parse(wrangler) as {
      exports?: Record<string, { type?: string; storage?: string }>;
    };
    expect(config.exports?.TwitterOAuthRefreshCoordinator).toEqual({
      type: "durable-object",
      storage: "sqlite",
    });
  });
});
