/**
 * Unit tests for SOC2 auth-hardening middleware:
 *   - `assertOrgMembership` (cross-org IDOR closure)
 *   - `requireApiKeyPermission` (API-key permission enforcement)
 *
 * These are pure middleware/helper tests — no Worker, no DB. The global
 * audit dispatcher is swapped for an in-memory sink so we can verify
 * audit emissions without persisting anything.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { Hono } from "hono";
import {
  AuditDispatcher,
  InMemorySink,
} from "@elizaos/security/audit";

// Import from the dedicated `api-key-permission` module — not `auth.ts` —
// so this test does not pull in the global auth-gate's transitive deps
// (which are mocked-out by another test file in the same bun process).
import { requireApiKeyPermission } from "../src/middleware/api-key-permission";
import { assertOrgMembership } from "../src/middleware/org-membership";
import { setAuditDispatcher } from "../src/services/audit-dispatcher-singleton";

let sink: InMemorySink;

beforeEach(() => {
  sink = new InMemorySink();
  setAuditDispatcher(
    new AuditDispatcher({
      sinks: [sink],
      onSinkError: () => undefined,
    }),
  );
});

describe("assertOrgMembership", () => {
  test("passes through when actor org matches resource org", async () => {
    const app = new Hono();
    app.get("/x", async (c) => {
      await assertOrgMembership(
        { id: "user-1", organization_id: "org-A" },
        "org-A",
        { resourceType: "agent", resourceId: "agent-1", c: c as never },
      );
      return c.json({ ok: true });
    });
    const res = await app.request("/x");
    expect(res.status).toBe(200);
    expect(sink.snapshot()).toHaveLength(0);
  });

  test("throws 403 + emits denied audit on cross-org access", async () => {
    const app = new Hono();
    app.get("/x", async (c) => {
      await assertOrgMembership(
        { id: "user-1", organization_id: "org-A" },
        "org-B",
        { resourceType: "agent", resourceId: "agent-1", c: c as never },
      );
      return c.json({ ok: true });
    });
    app.onError((err, c) => {
      const status =
        err && typeof err === "object" && "status" in err
          ? (err as { status: number }).status
          : 500;
      return c.json({ error: err.message }, status as 403 | 500);
    });
    const res = await app.request("/x");
    expect(res.status).toBe(403);
    const events = sink.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("agent.config.update");
    expect(events[0]?.result).toBe("denied");
    expect(events[0]?.actor.id).toBe("user-1");
    expect(events[0]?.resource?.id).toBe("agent-1");
  });

  test("throws 403 + emits when resource has no org id", async () => {
    const app = new Hono();
    app.get("/x", async (c) => {
      await assertOrgMembership(
        { id: "user-1", organization_id: "org-A" },
        null,
        { resourceType: "secret", resourceId: "s-1", c: c as never },
      );
      return c.json({ ok: true });
    });
    app.onError((err, c) =>
      c.json({ error: err.message }, "status" in err ? (err as any).status : 500),
    );
    const res = await app.request("/x");
    expect(res.status).toBe(403);
    const events = sink.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("secret.access");
  });
});

describe("requireApiKeyPermission", () => {
  function buildApp(perm: string) {
    const app = new Hono<{ Variables: any }>();
    app.use("*", requireApiKeyPermission(perm));
    app.get("/", (c) => c.json({ ok: true }));
    app.onError((err, c) =>
      c.json({ error: err.message }, "status" in err ? (err as any).status : 500),
    );
    return app;
  }

  test("session-auth requests pass through (no permission check)", async () => {
    const app = buildApp("agents:write");
    // No authMethod set — same as session auth context.
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });

  test("exact permission match passes", async () => {
    const app = new Hono<{ Variables: any }>();
    app.use("*", async (c, next) => {
      c.set("authMethod", "api_key");
      c.set("apiKeyId", "key-1");
      c.set("apiKeyPermissions", ["agents:write"]);
      await next();
    });
    app.use("*", requireApiKeyPermission("agents:write"));
    app.get("/", (c) => c.json({ ok: true }));
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });

  test("wildcard '*' grants any permission", async () => {
    const app = new Hono<{ Variables: any }>();
    app.use("*", async (c, next) => {
      c.set("authMethod", "api_key");
      c.set("apiKeyId", "key-1");
      c.set("apiKeyPermissions", ["*"]);
      await next();
    });
    app.use("*", requireApiKeyPermission("agents:write"));
    app.get("/", (c) => c.json({ ok: true }));
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });

  test("prefix wildcard grants matching scope", async () => {
    const app = new Hono<{ Variables: any }>();
    app.use("*", async (c, next) => {
      c.set("authMethod", "api_key");
      c.set("apiKeyId", "key-1");
      c.set("apiKeyPermissions", ["agents:*"]);
      await next();
    });
    app.use("*", requireApiKeyPermission("agents:write"));
    app.get("/", (c) => c.json({ ok: true }));
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });

  test("missing permission returns 403 + emits denied audit", async () => {
    const app = new Hono<{ Variables: any }>();
    app.use("*", async (c, next) => {
      c.set("authMethod", "api_key");
      c.set("apiKeyId", "key-1");
      c.set("apiKeyPermissions", ["containers:deploy"]);
      c.set("user", {
        id: "user-1",
        organization_id: "org-A",
      });
      await next();
    });
    app.use("*", requireApiKeyPermission("agents:write"));
    app.get("/", (c) => c.json({ ok: true }));
    app.onError((err, c) =>
      c.json({ error: err.message }, "status" in err ? (err as any).status : 500),
    );
    const res = await app.request("/");
    expect(res.status).toBe(403);
    const events = sink.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("api_key.use");
    expect(events[0]?.result).toBe("denied");
    expect(events[0]?.actor.type).toBe("api_key");
    expect(events[0]?.actor.id).toBe("key-1");
  });
});
