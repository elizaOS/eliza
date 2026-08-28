import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { assertOAuthState, waitForLoopbackCallback } from "./interactive.js";

/** Grab a currently-free loopback port by binding and releasing a temp server. */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe("assertOAuthState", () => {
  it("passes when the states match", () => {
    expect(() => assertOAuthState("abc", "abc")).not.toThrow();
  });

  it("rejects mismatched state", () => {
    expect(() => assertOAuthState("abc", "def")).toThrow(
      "OAuth state mismatch",
    );
  });

  it("rejects missing state", () => {
    expect(() => assertOAuthState(undefined, "def")).toThrow(
      "OAuth state mismatch",
    );
    expect(() => assertOAuthState(null, "def")).toThrow("OAuth state mismatch");
  });
});

describe("waitForLoopbackCallback", () => {
  it("rejects non-loopback redirect URIs before binding anything", async () => {
    await expect(
      waitForLoopbackCallback("https://example.com/callback", "state", 1000),
    ).rejects.toThrow("Redirect URI must be loopback");
  });

  it("resolves with code and state for a well-formed callback", async () => {
    const port = await freePort();
    const state = "s3cret-state";
    const promise = waitForLoopbackCallback(
      `http://127.0.0.1:${port}/callback`,
      state,
      5000,
    );
    const res = await fetch(
      `http://127.0.0.1:${port}/callback?code=AUTH_CODE&state=${state}`,
    );
    expect(res.status).toBe(200);
    await expect(promise).resolves.toEqual({ code: "AUTH_CODE", state });
  });

  it("rejects when the callback state does not match (CSRF guard)", async () => {
    const port = await freePort();
    const assertion = expect(
      waitForLoopbackCallback(
        `http://127.0.0.1:${port}/cb`,
        "expected-state",
        5000,
      ),
    ).rejects.toThrow("OAuth state mismatch");
    const res = await fetch(
      `http://127.0.0.1:${port}/cb?code=X&state=attacker-state`,
    );
    expect(res.status).toBe(400);
    await assertion;
  });

  it("rejects a callback that is missing the authorization code", async () => {
    const port = await freePort();
    const assertion = expect(
      waitForLoopbackCallback(`http://127.0.0.1:${port}/cb`, "s", 5000),
    ).rejects.toThrow("Missing code");
    const res = await fetch(`http://127.0.0.1:${port}/cb?state=s`);
    expect(res.status).toBe(400);
    await assertion;
  });

  it("rejects an OAuth error redirect", async () => {
    const port = await freePort();
    const assertion = expect(
      waitForLoopbackCallback(`http://127.0.0.1:${port}/cb`, "s", 5000),
    ).rejects.toThrow("OAuth error: access_denied");
    const res = await fetch(`http://127.0.0.1:${port}/cb?error=access_denied`);
    expect(res.status).toBe(400);
    await assertion;
  });

  it("answers 404 for unknown paths and keeps waiting for the real one", async () => {
    const port = await freePort();
    const state = "s";
    const promise = waitForLoopbackCallback(
      `http://127.0.0.1:${port}/cb`,
      state,
      5000,
    );
    const wrong = await fetch(
      `http://127.0.0.1:${port}/wrong?code=X&state=${state}`,
    );
    expect(wrong.status).toBe(404);
    const right = await fetch(
      `http://127.0.0.1:${port}/cb?code=Y&state=${state}`,
    );
    expect(right.status).toBe(200);
    await expect(promise).resolves.toEqual({ code: "Y", state });
  });

  it("times out when no callback arrives", async () => {
    const port = await freePort();
    await expect(
      waitForLoopbackCallback(`http://127.0.0.1:${port}/cb`, "s", 100),
    ).rejects.toThrow("Timed out waiting for Twitter OAuth callback");
  }, 10_000);
});
