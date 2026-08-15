/** Exercises the registered forwarder-auth readiness route with real Hono requests and process configuration. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerForwarderAuthReadinessRoute } from "../src/forwarder-auth-readiness";

const app = new Hono();
registerForwarderAuthReadinessRoute(app);

const secretBeforeTests = process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET;
const projectBeforeTests = process.env.ELIZA_APP_WEBHOOK_PROJECT;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("forwarder-auth readiness route", () => {
  beforeEach(() => {
    process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET = "integration-secret";
    delete process.env.ELIZA_APP_WEBHOOK_PROJECT;
  });

  afterEach(() => {
    restoreEnv("ELIZA_APP_WEBHOOK_GATEWAY_SECRET", secretBeforeTests);
    restoreEnv("ELIZA_APP_WEBHOOK_PROJECT", projectBeforeTests);
  });

  test("reserves headerless 401 for an enforced eliza-app gate", async () => {
    const response = await app.request(
      "http://gateway.example/ready/forwarder-auth/eliza-app",
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "unauthorized",
      status: "enforced",
      project: "eliza-app",
    });
  });

  test("returns distinct non-401 readiness failure when the secret is disabled", async () => {
    delete process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET;
    const response = await app.request(
      "http://gateway.example/ready/forwarder-auth/eliza-app",
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "forwarder-auth-not-ready",
      reason: "secret-disabled",
      project: "eliza-app",
    });
  });

  test("returns distinct non-401 readiness failure for a project mismatch", async () => {
    process.env.ELIZA_APP_WEBHOOK_PROJECT = "another-project";
    const response = await app.request(
      "http://gateway.example/ready/forwarder-auth/eliza-app",
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "forwarder-auth-not-ready",
      reason: "project-mismatch",
      project: "eliza-app",
    });
  });

  test("rejects supplied forwarder headers without comparing their values", async () => {
    const request = (value: string) =>
      app.request("http://gateway.example/ready/forwarder-auth/eliza-app", {
        headers: { "X-Eliza-Webhook-Forwarder-Secret": value },
      });

    for (const value of ["integration-secret", "wrong-secret"]) {
      const response = await request(value);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "forwarder-auth-probe-must-omit-secret",
      });
    }
  });

  test("does not expose a POST surface that could enter provider handling", async () => {
    const response = await app.request(
      "http://gateway.example/ready/forwarder-auth/eliza-app",
      { method: "POST", body: "{}" },
    );
    expect(response.status).toBe(404);
  });
});
