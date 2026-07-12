// `/api/health/operational` surfaces the KMS backend CLASS (never key material)
// so a deploy verifier can assert a deployed environment did not silently fall
// back to the ephemeral `memory` backend (#15310). Drives env through the
// cloud-bindings ALS the same way the Worker sets it per request.

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// Keep the route's noisy deps quiet + deterministic. The logger's real
// `@elizaos/core` barrel is heavy; a stub keeps this a fast unit test.
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), warn: mock(), info: mock(), debug: mock() },
}));

import { runWithCloudBindings } from "@/lib/runtime/cloud-bindings";

const operationalRoute = (await import("./route")).default;

function mount() {
  const app = new Hono();
  app.route("/api/health/operational", operationalRoute);
  return app;
}

async function getBody(env: Record<string, string>): Promise<{
  status: string;
  checks: { kms: { backend: string; durable: boolean; message: string } };
}> {
  const app = mount();
  return await runWithCloudBindings(env, async () => {
    const res = await app.request("/api/health/operational");
    expect(res.status).toBe(200);
    return (await res.json()) as {
      status: string;
      checks: { kms: { backend: string; durable: boolean; message: string } };
    };
  });
}

describe("GET /api/health/operational — kms backend class surface", () => {
  test("staging + memory backend → kms.durable=false and top-level status=degraded", async () => {
    const body = await getBody({
      ENVIRONMENT: "staging",
      ELIZA_KMS_BACKEND: "memory",
    });
    expect(body.checks.kms.backend).toBe("memory");
    expect(body.checks.kms.durable).toBe(false);
    // A non-durable KMS in a deployed env must drag the whole check to degraded
    // so a single boolean grep (or the routing-verifier) catches the misconfig.
    expect(body.status).toBe("degraded");
    expect(body.checks.kms.message).toContain("ephemeral");
  });

  test("staging + local backend + valid key → kms.durable=true (does not by itself degrade)", async () => {
    const body = await getBody({
      ENVIRONMENT: "staging",
      ELIZA_KMS_BACKEND: "local",
      ELIZA_LOCAL_ROOT_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString(
        "base64",
      ),
    });
    expect(body.checks.kms.backend).toBe("local");
    expect(body.checks.kms.durable).toBe(true);
    expect(body.checks.kms.message).toContain("durable");
  });

  test("staging + local backend + MISSING key → kms.durable=false and status=degraded (was falsely healthy before)", async () => {
    // Override NODE_ENV via the ALS store: the security factory only mints a
    // random ephemeral local key when NODE_ENV=test (which the test process
    // carries on process.env). Forcing a non-test NODE_ENV reproduces the
    // deployed behavior where a missing ELIZA_LOCAL_ROOT_KEY is fatal.
    const body = await getBody({
      ENVIRONMENT: "staging",
      NODE_ENV: "production",
      ELIZA_KMS_BACKEND: "local",
    });
    expect(body.checks.kms.backend).toBe("local");
    expect(body.checks.kms.durable).toBe(false);
    expect(body.status).toBe("degraded");
    expect(body.checks.kms.message).toContain("NOT durable");
  });

  test("never leaks key material — ELIZA_LOCAL_ROOT_KEY absent from the payload", async () => {
    const rootKey = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
    const app = mount();
    await runWithCloudBindings(
      {
        ENVIRONMENT: "staging",
        ELIZA_KMS_BACKEND: "local",
        ELIZA_LOCAL_ROOT_KEY: rootKey,
      },
      async () => {
        const res = await app.request("/api/health/operational");
        const text = await res.text();
        expect(text).not.toContain(rootKey);
      },
    );
  });
});
