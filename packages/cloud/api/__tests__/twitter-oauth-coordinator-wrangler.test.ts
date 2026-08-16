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

  test("registers the Durable Object class migration", () => {
    expect(wrangler).toContain('tag = "twitter-oauth-refresh-coordinator-v1"');
    expect(wrangler).toContain(
      'new_sqlite_classes = ["TwitterOAuthRefreshCoordinator"]',
    );
  });
});
