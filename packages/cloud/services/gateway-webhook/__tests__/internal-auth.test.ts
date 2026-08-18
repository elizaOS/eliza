/** Exercises gateway internal-auth boundaries with deterministic service fixtures. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  enforceForwarderSecret,
  getForwarderAuthReadiness,
  validateInternalSecret,
} from "../src/internal-auth";

describe("validateInternalSecret", () => {
  const originalSecret = process.env.GATEWAY_INTERNAL_SECRET;

  beforeEach(() => {
    process.env.GATEWAY_INTERNAL_SECRET = "test-k8s-secret";
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.GATEWAY_INTERNAL_SECRET;
    } else {
      process.env.GATEWAY_INTERNAL_SECRET = originalSecret;
    }
  });

  function makeRequest(secret?: string): Request {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (secret !== undefined) {
      headers["X-Internal-Secret"] = secret;
    }
    return new Request("http://localhost/internal/event", {
      method: "POST",
      headers,
      body: "{}",
    });
  }

  test("returns false when GATEWAY_INTERNAL_SECRET env is empty", () => {
    process.env.GATEWAY_INTERNAL_SECRET = "";
    expect(validateInternalSecret(makeRequest("any-value"))).toBe(false);
  });

  test("returns false when GATEWAY_INTERNAL_SECRET env is not set", () => {
    delete process.env.GATEWAY_INTERNAL_SECRET;
    expect(validateInternalSecret(makeRequest("any-value"))).toBe(false);
  });

  test("returns false when header is missing", () => {
    expect(validateInternalSecret(makeRequest())).toBe(false);
  });

  test("returns false when header value is wrong", () => {
    expect(validateInternalSecret(makeRequest("wrong-secret"))).toBe(false);
  });

  test("returns false when header does not match secret (length and value differ)", () => {
    process.env.GATEWAY_INTERNAL_SECRET = "short";
    expect(
      validateInternalSecret(makeRequest("this-is-a-much-longer-secret-value")),
    ).toBe(false);
  });

  test("returns false for multi-byte UTF-8 secret with different encoding", () => {
    process.env.GATEWAY_INTERNAL_SECRET = "café";
    expect(validateInternalSecret(makeRequest("café"))).toBe(true);
    expect(validateInternalSecret(makeRequest("cafe"))).toBe(false);
  });

  test("returns true when header matches GATEWAY_INTERNAL_SECRET", () => {
    expect(validateInternalSecret(makeRequest("test-k8s-secret"))).toBe(true);
  });
});

// W5-033: POST /drain latches the process-global draining flag, so it must sit
// behind the same X-Internal-Secret gate as /internal/deliver — the service is
// the public webhook ingress, and an unauthenticated drain 503s /ready on every
// replica until restart. These pin the route wiring in src/index.ts so the
// guard cannot be dropped without failing CI (mirrors gateway-discord's
// internal-auth contract).
describe("operational route auth wiring", () => {
  const indexSource = async () =>
    Bun.file(new URL("../src/index.ts", import.meta.url)).text();

  test("/drain and /internal/deliver require the internal secret", async () => {
    const source = await indexSource();
    for (const route of ['"/drain"', '"/internal/deliver"']) {
      const routeIndex = source.indexOf(route);
      expect(routeIndex).toBeGreaterThan(-1);
      const handler = source.slice(routeIndex, routeIndex + 500);
      expect(handler).toContain("validateInternalSecret(c.req.raw)");
      expect(handler).toContain("401");
    }
  });

  test("/health and /ready stay unauthenticated for probes", async () => {
    const source = await indexSource();
    for (const route of ['"/health"', '"/ready"']) {
      const routeIndex = source.indexOf(route);
      expect(routeIndex).toBeGreaterThan(-1);
      const handler = source.slice(routeIndex, routeIndex + 300);
      expect(handler).not.toContain("validateInternalSecret");
    }
  });
});

// enforceForwarderSecret gates the public webhook routes (finding L3, #12878).
// Uses the DEDICATED ELIZA_APP_WEBHOOK_GATEWAY_SECRET (decoupled from the
// internal-event GATEWAY_INTERNAL_SECRET). Fail-closed when the dedicated secret
// is configured; backward-compatible no-op when not.
describe("enforceForwarderSecret", () => {
  const originalForwarder = process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET;
  const originalProject = process.env.ELIZA_APP_WEBHOOK_PROJECT;
  const originalInternal = process.env.GATEWAY_INTERNAL_SECRET;

  afterEach(() => {
    if (originalForwarder === undefined) {
      delete process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET;
    } else {
      process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET = originalForwarder;
    }
    if (originalProject === undefined) {
      delete process.env.ELIZA_APP_WEBHOOK_PROJECT;
    } else {
      process.env.ELIZA_APP_WEBHOOK_PROJECT = originalProject;
    }
    if (originalInternal === undefined) {
      delete process.env.GATEWAY_INTERNAL_SECRET;
    } else {
      process.env.GATEWAY_INTERNAL_SECRET = originalInternal;
    }
  });

  const FORWARDED_PROJECT = "eliza-app";

  function webhookRequest(secret?: string): Request {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (secret !== undefined) {
      headers["X-Eliza-Webhook-Forwarder-Secret"] = secret;
    }
    return new Request("http://localhost/webhook/eliza-app/telegram", {
      method: "POST",
      headers,
      body: "{}",
    });
  }

  test("no forwarder secret configured => gate is a no-op (allows traffic)", () => {
    delete process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET;
    expect(getForwarderAuthReadiness(FORWARDED_PROJECT)).toBe(
      "secret-disabled",
    );
    expect(enforceForwarderSecret(webhookRequest(), FORWARDED_PROJECT)).toBe(
      true,
    );
    expect(
      enforceForwarderSecret(webhookRequest("anything"), FORWARDED_PROJECT),
    ).toBe(true);
  });

  test("internal-event secret alone does NOT enable the gate (decoupled)", () => {
    // Deployments that only set GATEWAY_INTERNAL_SECRET (for /internal/event)
    // must keep serving direct provider webhooks unchanged.
    delete process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET;
    process.env.GATEWAY_INTERNAL_SECRET = "internal-only";
    expect(enforceForwarderSecret(webhookRequest(), FORWARDED_PROJECT)).toBe(
      true,
    );
  });

  test("forwarder secret configured + valid header => allowed", () => {
    process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET = "bff-secret";
    expect(getForwarderAuthReadiness(FORWARDED_PROJECT)).toBe("enforced");
    expect(
      enforceForwarderSecret(webhookRequest("bff-secret"), FORWARDED_PROJECT),
    ).toBe(true);
  });

  test("forwarder secret configured + missing header => rejected (fail-closed)", () => {
    process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET = "bff-secret";
    expect(enforceForwarderSecret(webhookRequest(), FORWARDED_PROJECT)).toBe(
      false,
    );
  });

  test("forwarder secret configured + wrong header => rejected", () => {
    process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET = "bff-secret";
    expect(
      enforceForwarderSecret(webhookRequest("nope"), FORWARDED_PROJECT),
    ).toBe(false);
  });

  test("a DIFFERENT project is NOT gated even when the secret is set", () => {
    // Other gateway tenants that post directly with valid provider auth must
    // never be blocked by the eliza-app forwarder gate.
    process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET = "bff-secret";
    // No forwarder header at all, but a non-forwarded project => allowed.
    expect(enforceForwarderSecret(webhookRequest(), "some-other-project")).toBe(
      true,
    );
  });

  test("configured forwarded-project mismatch is distinct from an enabled gate", () => {
    process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET = "bff-secret";
    process.env.ELIZA_APP_WEBHOOK_PROJECT = "different-project";
    expect(getForwarderAuthReadiness(FORWARDED_PROJECT)).toBe(
      "project-mismatch",
    );
    expect(enforceForwarderSecret(webhookRequest(), FORWARDED_PROJECT)).toBe(
      true,
    );
  });

  test("a blank dedicated secret reports disabled readiness", () => {
    process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET = "  \n";
    expect(getForwarderAuthReadiness(FORWARDED_PROJECT)).toBe(
      "secret-disabled",
    );
  });

  test("trims the env secret to match the trimmed value the BFF stamps", () => {
    // K8s secret mounts commonly carry a trailing newline. The BFF forwarder
    // stamps the trimmed value, so the gateway must trim too or every forward
    // 401s despite both sides sharing the same secret.
    process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET = "bff-secret\n";
    expect(
      enforceForwarderSecret(webhookRequest("bff-secret"), FORWARDED_PROJECT),
    ).toBe(true);
  });
});
