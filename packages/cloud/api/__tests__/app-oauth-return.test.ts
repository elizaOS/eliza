import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  buildAppOAuthReturn,
  resolveAppOAuthReturn,
} from "../v1/oauth/app-oauth-return";

const now = 100_000;
const nonce = "a".repeat(43);
const callbacks = [
  "https://apps.example.org/reader/callback",
  "https://other.example.test/planner/connected",
];
const state = (callback: string) => ({
  providerId: "google",
  redirectUrl: `${callback}?state=${nonce}`,
  createdAt: now - 1000,
  organizationId: "organization",
  userId: "owner",
});

test("deployments own callback allowlists and releases preserve their bindings", async () => {
  const config = Bun.TOML.parse(
    await readFile(new URL("../wrangler.toml", import.meta.url), "utf8"),
  ) as {
    keep_vars: boolean;
    vars?: Record<string, unknown>;
    env: Record<string, { vars?: Record<string, unknown> }>;
  };
  expect(config.keep_vars).toBe(true);
  for (const scope of [config, ...Object.values(config.env)]) {
    expect(Object.hasOwn(scope.vars ?? {}, "APP_OAUTH_RETURN_URLS")).toBe(
      false,
    );
  }
});

test("any configured application can use the exact callback and its own nonce", () => {
  for (const callback of callbacks) {
    const target = resolveAppOAuthReturn(
      state(callback),
      "google",
      callbacks.join(", "),
      now,
    );
    expect(target).toEqual({
      url: callback,
      state: nonce,
      source: `${callback}?state=${nonce}`,
    });
    const result = new URL(
      buildAppOAuthReturn(target!, "connected", "connection_123"),
    );
    expect(result.origin + result.pathname).toBe(callback);
    expect(result.search).toBe("");
    expect(
      Object.fromEntries(new URLSearchParams(result.hash.slice(1))),
    ).toEqual({
      state: nonce,
      result: "connected",
      connectionId: "connection_123",
    });
  }
});

test("missing configuration and unlisted or malformed callbacks fail closed", () => {
  expect(
    resolveAppOAuthReturn(state(callbacks[0]), "google", undefined, now),
  ).toBeNull();
  for (const callback of [
    "https://unlisted.example.test/callback",
    `${callbacks[0]}/extra`,
    callbacks[0].replace("https:", "http:"),
  ]) {
    expect(
      resolveAppOAuthReturn(
        state(callback),
        "google",
        callbacks.join(","),
        now,
      ),
    ).toBeNull();
  }
  expect(
    resolveAppOAuthReturn(
      { ...state(callbacks[0]), createdAt: now - 600_000 },
      "google",
      callbacks.join(","),
      now,
    ),
  ).toBeNull();
  expect(
    resolveAppOAuthReturn(
      {
        ...state(callbacks[0]),
        redirectUrl: `${callbacks[0]}?state=${nonce}&next=elsewhere`,
      },
      "google",
      callbacks.join(","),
      now,
    ),
  ).toBeNull();
});
