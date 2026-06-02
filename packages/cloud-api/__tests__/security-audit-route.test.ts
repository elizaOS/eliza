/**
 * Tests for POST /api/v1/security/audit.
 *
 * The route accepts browser-originated audit requests, but it must validate the
 * requested action/result/resource/metadata and stamp server-owned actor fields.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { AuditDispatcher, InMemorySink } from "@elizaos/security/audit";
import { setAuditDispatcher } from "../src/services/audit-dispatcher-singleton";

const requireUserWithOrg =
  mock<(c: unknown) => Promise<{ id: string; organization_id: string }>>();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserWithOrg,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

let auditRoute: { default: { fetch: (req: Request) => Promise<Response> } };
let sink: InMemorySink;

beforeAll(async () => {
  auditRoute = (await import(
    "../v1/security/audit/route"
  )) as typeof auditRoute;
});

beforeEach(() => {
  sink = new InMemorySink();
  setAuditDispatcher(
    new AuditDispatcher({
      sinks: [sink],
      onSinkError: () => undefined,
    }),
  );
  requireUserWithOrg.mockResolvedValue({
    id: "user-1",
    organization_id: "org-1",
  });
});

afterEach(() => {
  requireUserWithOrg.mockReset();
});

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://test.local/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "audit-test",
      "CF-Connecting-IP": "203.0.113.10",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/security/audit", () => {
  test("emits a server-stamped audit event for valid client input", async () => {
    const res = await auditRoute.default.fetch(
      makeRequest({
        action: "secret.access",
        result: "deny",
        resource: { type: "secret", id: "secret-1" },
        metadata: { reason: "org_mismatch", resource_org_id: "org-2" },
      }),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok?: boolean; event_id?: string };
    expect(body.ok).toBe(true);
    expect(body.event_id).toBeString();

    const events = sink.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: { type: "user", id: "user-1" },
      action: "secret.access",
      result: "denied",
      resource: { type: "secret", id: "secret-1" },
      ip: "203.0.113.10",
      user_agent: "audit-test",
      org_id: "org-1",
      metadata: { reason: "org_mismatch" },
    });
  });

  test("rejects malformed client audit payloads without emitting", async () => {
    const badPayloads: unknown[] = [
      { action: "not.allowed", result: "allow" },
      { action: "secret.access", result: "success" },
      {
        action: "secret.access",
        result: "allow",
        resource: { type: "", id: "x" },
      },
      {
        action: "secret.access",
        result: "allow",
        metadata: { nested: { nope: true } },
      },
    ];

    for (const payload of badPayloads) {
      const res = await auditRoute.default.fetch(makeRequest(payload));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("validation_error");
    }

    expect(sink.snapshot()).toHaveLength(0);
  });
});
