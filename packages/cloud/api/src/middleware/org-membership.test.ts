/**
 * Unit coverage for `assertOrgMembership`. Drives the real helper through a
 * Hono request context and a real `AuditDispatcher` + in-memory sink. `@/`
 * aliases are redirected to source (or a no-op audit-events sink) so Vitest
 * can collect the file without the cloud-api tsconfig path map.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../../shared/src/lib/api/cloud-worker-errors";

vi.mock("@/lib/utils/logger", () => ({
  logger: {
    warn: () => undefined,
    error: () => undefined,
    info: () => undefined,
    debug: () => undefined,
  },
}));

vi.mock(
  "@/lib/api/cloud-worker-errors",
  () => import("../../../shared/src/lib/api/cloud-worker-errors.ts"),
);

vi.mock("@/api-app/services/audit", () => import("../services/audit/index.ts"));

vi.mock("../services/audit-events", () => ({
  auditEventsSink: {
    name: "auth_events_pg",
    required: false,
    emit: async () => undefined,
  },
}));

vi.mock("@/db/client", () => ({
  dbWrite: { insert: () => ({ values: async () => undefined }) },
}));

const bunTest = await import("bun:test").catch(() => null);
if (bunTest && typeof bunTest.mock.module === "function") {
  bunTest.mock.module("@/lib/utils/logger", () => ({
    logger: {
      warn: () => undefined,
      error: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    },
  }));
  bunTest.mock.module(
    "@/lib/api/cloud-worker-errors",
    () => import("../../../shared/src/lib/api/cloud-worker-errors.ts"),
  );
  bunTest.mock.module(
    "@/api-app/services/audit",
    () => import("../services/audit/index.ts"),
  );
  bunTest.mock.module("../services/audit-events", () => ({
    auditEventsSink: {
      name: "auth_events_pg",
      required: false,
      emit: async () => undefined,
    },
  }));
  bunTest.mock.module("@/db/client", () => ({
    dbWrite: { insert: () => ({ values: async () => undefined }) },
  }));
}

const { assertOrgMembership } = await import("./org-membership");
const { AuditDispatcher } = await import("../services/audit");
const { InMemorySink } = await import("../services/audit/testing");
const { setAuditDispatcher } = await import(
  "../services/audit-dispatcher-singleton"
);

const ACTOR = { id: "user-1", organization_id: "org-A" };

type InvokeInput = {
  resourceOrgId: string | null | undefined;
  resourceType?: string;
  resourceId?: string;
  headers?: Record<string, string>;
  requestId?: string;
};

let sink: InstanceType<typeof InMemorySink>;

beforeEach(() => {
  sink = new InMemorySink();
  setAuditDispatcher(
    new AuditDispatcher({
      sinks: [sink],
      onSinkError: () => undefined,
    }),
  );
});

async function invoke(input: InvokeInput): Promise<{
  status: number;
  body: { error?: string; code?: string; ok?: boolean };
}> {
  const app = new Hono();
  app.get("/x", async (c) => {
    if (input.requestId !== undefined) {
      c.set("requestId", input.requestId);
    }
    await assertOrgMembership(ACTOR, input.resourceOrgId, {
      resourceType: input.resourceType ?? "agent",
      resourceId: input.resourceId ?? "agent-1",
      c: c as never,
    });
    return c.json({ ok: true });
  });
  app.onError((err, c) => {
    const status =
      err instanceof ApiError
        ? err.status
        : err && typeof err === "object" && "status" in err
          ? Number((err as { status: number }).status)
          : 500;
    const code = err instanceof ApiError ? err.code : undefined;
    return c.json({ error: err.message, code }, status as never);
  });
  const res = await app.request("/x", { headers: input.headers });
  return {
    status: res.status,
    body: (await res.json()) as {
      error?: string;
      code?: string;
      ok?: boolean;
    },
  };
}

describe("assertOrgMembership", () => {
  test("returns through with no audit event when actor org matches resource org", async () => {
    const { status, body } = await invoke({ resourceOrgId: "org-A" });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(sink.snapshot()).toHaveLength(0);
  });

  test("denies a missing resource org id even when the actor has an org", async () => {
    for (const resourceOrgId of [null, undefined, ""] as const) {
      sink.clear();
      const { status, body } = await invoke({
        resourceOrgId,
        resourceType: "secret",
        resourceId: "s-1",
      });
      expect(status).toBe(403);
      expect(body.error).toBe("Resource not accessible to this organization");
      expect(body.code).toBe("access_denied");
      expect(sink.snapshot()).toHaveLength(1);
      expect(sink.snapshot()[0]?.action).toBe("secret.access");
      expect(sink.snapshot()[0]?.result).toBe("denied");
    }
  });

  test("denies a whitespace-only resource org id (truthy, but not equal)", async () => {
    const { status } = await invoke({ resourceOrgId: "   " });
    expect(status).toBe(403);
    expect(sink.snapshot()).toHaveLength(1);
  });

  test("denies a case-mismatched org id (comparison is exact)", async () => {
    const { status } = await invoke({ resourceOrgId: "ORG-A" });
    expect(status).toBe(403);
    expect(sink.snapshot()).toHaveLength(1);
  });

  test("denies a trailing-space org id that is not identical", async () => {
    const { status } = await invoke({ resourceOrgId: "org-A " });
    expect(status).toBe(403);
  });

  test.each([
    ["api_key", "api_key.use"],
    ["agent", "agent.config.update"],
    ["container", "agent.config.update"],
    ["pooled_credential", "secret.access"],
    ["secret", "secret.access"],
    ["workflow", "agent.config.update"],
    ["unknown-kind", "admin.action"],
    ["Agent", "admin.action"],
  ] as const)(
    "maps resourceType %s to audit action %s on cross-org denial",
    async (resourceType, action) => {
      const { status, body } = await invoke({
        resourceOrgId: "org-B",
        resourceType,
        resourceId: "res-9",
      });
      expect(status).toBe(403);
      expect(body.code).toBe("access_denied");
      const events = sink.snapshot();
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe(action);
      expect(events[0]?.result).toBe("denied");
      expect(events[0]?.actor).toEqual({ type: "user", id: "user-1" });
      expect(events[0]?.resource).toEqual({ type: resourceType, id: "res-9" });
      expect(events[0]?.org_id).toBe("org-A");
      expect(events[0]?.metadata).toEqual({ reason: "cross_org_access" });
    },
  );

  test("records the first trimmed x-forwarded-for hop and ignores x-real-ip", async () => {
    const { status } = await invoke({
      resourceOrgId: "org-B",
      headers: {
        "x-forwarded-for": "  203.0.113.10, 198.51.100.1 ",
        "x-real-ip": "192.0.2.1",
        "user-agent": "org-membership-test/1.0",
      },
      requestId: "req-77",
    });
    expect(status).toBe(403);
    const event = sink.snapshot()[0];
    expect(event?.ip).toBe("203.0.113.10");
    expect(event?.user_agent).toBe("org-membership-test/1.0");
    expect(event?.request_id).toBe("req-77");
  });

  test("falls through to x-real-ip when x-forwarded-for is missing", async () => {
    const { status } = await invoke({
      resourceOrgId: "org-B",
      headers: { "x-real-ip": "192.0.2.9" },
    });
    expect(status).toBe(403);
    expect(sink.snapshot()[0]?.ip).toBe("192.0.2.9");
  });

  test("falls through to x-real-ip when the first forwarded hop trims empty", async () => {
    const { status } = await invoke({
      resourceOrgId: "org-B",
      headers: {
        "x-forwarded-for": "  , 198.51.100.1",
        "x-real-ip": "192.0.2.8",
      },
    });
    expect(status).toBe(403);
    expect(sink.snapshot()[0]?.ip).toBe("192.0.2.8");
  });

  test("omits ip, user_agent, and request_id when those headers and vars are absent", async () => {
    const { status } = await invoke({ resourceOrgId: "org-B" });
    expect(status).toBe(403);
    const event = sink.snapshot()[0];
    expect(event?.ip).toBeUndefined();
    expect(event?.user_agent).toBeUndefined();
    expect(event?.request_id).toBeUndefined();
  });

  test("empty resourceType still 403s and records no event (audit schema rejects empty resource.type)", async () => {
    const { status, body } = await invoke({
      resourceOrgId: "org-B",
      resourceType: "",
      resourceId: "res-9",
    });
    expect(status).toBe(403);
    expect(body.code).toBe("access_denied");
    expect(sink.snapshot()).toHaveLength(0);
  });

  test("empty resourceId still 403s and records no event (audit schema rejects empty resource.id)", async () => {
    const { status, body } = await invoke({
      resourceOrgId: "org-B",
      resourceId: "",
    });
    expect(status).toBe(403);
    expect(body.code).toBe("access_denied");
    expect(sink.snapshot()).toHaveLength(0);
  });

  test("still throws 403 when a required audit sink rejects", async () => {
    setAuditDispatcher(
      new AuditDispatcher({
        sinks: [
          {
            name: "failing",
            emit: async () => {
              throw new Error("audit sink boom");
            },
          },
        ],
        onSinkError: () => undefined,
      }),
    );
    const { status, body } = await invoke({ resourceOrgId: "org-B" });
    expect(status).toBe(403);
    expect(body.error).toBe("Resource not accessible to this organization");
    expect(body.code).toBe("access_denied");
  });
});
