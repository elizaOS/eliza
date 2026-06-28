/**
 * Unit tests for SOC2 auth-hardening middleware:
 *   - `assertOrgMembership` (cross-org IDOR closure)
 *
 * These are pure middleware/helper tests — no Worker, no DB. The global
 * audit dispatcher is swapped for an in-memory sink so we can verify
 * audit emissions without persisting anything.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { AuditDispatcher, InMemorySink } from "@elizaos/security/audit";
import { Hono } from "hono";

import { assertOrgMembership } from "../src/middleware/org-membership";
import { setAuditDispatcher } from "../src/services/audit-dispatcher-singleton";

let sink: InMemorySink;

function errorStatus(err: Error): 403 | 500 {
  return err && typeof err === "object" && "status" in err
    ? (err as { status: 403 }).status
    : 500;
}

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
      return c.json({ error: err.message }, errorStatus(err));
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
    app.onError((err, c) => c.json({ error: err.message }, errorStatus(err)));
    const res = await app.request("/x");
    expect(res.status).toBe(403);
    const events = sink.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("secret.access");
  });
});
