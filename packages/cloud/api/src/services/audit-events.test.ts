/**
 * Unit coverage for AuditEventsSink. The real class maps an AuditEvent onto
 * the auth_events insert row; dbWrite is a capturing collaborator so each
 * assertion inspects the mapped values. There is no queue, capacity, or
 * comparator — the branches are the nullish optional-field mappings and
 * persistence-error propagation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "./audit/types.js";

// bun's vitest compat layer (the runner this package's unit lane uses) has no
// vi.hoisted, so build the collaborators inside the factories and reach them
// through the mocked module afterwards.
vi.mock("@/db/client", () => {
  const values = vi.fn(async (_row: Record<string, unknown>) => undefined);
  const insert = vi.fn((_table: unknown) => ({ values }));
  return { dbWrite: { insert }, __values: values, __insert: insert };
});

vi.mock("@/db/schemas/auth-events", () => ({
  authEvents: { name: "auth_events" as const },
}));

const dbClientModule = (await import("@/db/client")) as unknown as {
  __values: ReturnType<typeof vi.fn>;
  __insert: ReturnType<typeof vi.fn>;
};
const authEventsModule = (await import(
  "@/db/schemas/auth-events"
)) as unknown as {
  authEvents: { name: "auth_events" };
};
const harness = {
  values: dbClientModule.__values,
  insert: dbClientModule.__insert,
  authEvents: authEventsModule.authEvents,
};

const { AuditEventsSink, auditEventsSink } = await import("./audit-events");

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    event_id: "0198d3a0-0000-7000-8000-000000000001",
    ts: "2026-08-23T12:00:00.000Z",
    actor: { type: "user", id: "user-1" },
    action: "auth.login",
    result: "success",
    resource: null,
    ...overrides,
  };
}

describe("AuditEventsSink", () => {
  beforeEach(() => {
    harness.values.mockReset();
    harness.values.mockResolvedValue(undefined);
    harness.insert.mockClear();
  });

  it("exports a required auth_events_pg sink singleton", () => {
    expect(auditEventsSink).toBeInstanceOf(AuditEventsSink);
    expect(auditEventsSink.name).toBe("auth_events_pg");
    expect(auditEventsSink.required).toBe(true);
    const constructed = new AuditEventsSink();
    expect(constructed.name).toBe("auth_events_pg");
    expect(constructed.required).toBe(true);
  });

  it("inserts into the auth_events table with required fields and null optionals", async () => {
    const sink = new AuditEventsSink();
    const event = makeEvent();
    await sink.emit(event);

    expect(harness.insert).toHaveBeenCalledTimes(1);
    expect(harness.insert).toHaveBeenCalledWith(harness.authEvents);
    expect(harness.values).toHaveBeenCalledTimes(1);

    const row = harness.values.mock.calls[0]?.[0];
    expect(row).toEqual({
      event_id: event.event_id,
      ts: new Date("2026-08-23T12:00:00.000Z"),
      actor_type: "user",
      actor_id: "user-1",
      action: "auth.login",
      result: "success",
      resource_type: null,
      resource_id: null,
      ip: null,
      ua: null,
      request_id: null,
      org_id: null,
      metadata: null,
    });
    expect(row?.ts).toBeInstanceOf(Date);
    expect(Object.hasOwn(row ?? {}, "expires_at")).toBe(false);
  });

  it("maps a present resource onto resource_type and resource_id", async () => {
    const sink = new AuditEventsSink();
    await sink.emit(
      makeEvent({
        resource: { type: "api_key", id: "key-9" },
      }),
    );
    expect(harness.values.mock.calls[0]?.[0]).toMatchObject({
      resource_type: "api_key",
      resource_id: "key-9",
    });
  });

  it("passes through optional ip, user_agent, request_id, org_id, and metadata", async () => {
    const sink = new AuditEventsSink();
    const metadata = {
      ip: "203.0.113.8",
      email_hash: "abc",
      attempt: 2,
      reused: false,
      reason: null,
    };
    await sink.emit(
      makeEvent({
        ip: "203.0.113.8",
        user_agent: "eliza-cli/1.0",
        request_id: "req-22",
        org_id: "org-7",
        metadata,
      }),
    );
    expect(harness.values.mock.calls[0]?.[0]).toMatchObject({
      ip: "203.0.113.8",
      ua: "eliza-cli/1.0",
      request_id: "req-22",
      org_id: "org-7",
      metadata,
    });
  });

  it("stores empty strings and an empty metadata object rather than converting them to null", async () => {
    const sink = new AuditEventsSink();
    await sink.emit(
      makeEvent({
        ip: "",
        user_agent: "",
        request_id: "",
        org_id: "",
        metadata: {},
        resource: { type: "", id: "" },
      }),
    );
    expect(harness.values.mock.calls[0]?.[0]).toMatchObject({
      ip: "",
      ua: "",
      request_id: "",
      org_id: "",
      metadata: {},
      resource_type: "",
      resource_id: "",
    });
  });

  it("converts an offset timestamp string to the equivalent Date", async () => {
    const sink = new AuditEventsSink();
    await sink.emit(makeEvent({ ts: "2026-08-23T08:00:00.000-04:00" }));
    const ts = harness.values.mock.calls[0]?.[0]?.ts;
    expect(ts).toBeInstanceOf(Date);
    expect((ts as Date).toISOString()).toBe("2026-08-23T12:00:00.000Z");
  });

  it("copies actor type, actor id, action, and result without rewriting them", async () => {
    const sink = new AuditEventsSink();
    await sink.emit(
      makeEvent({
        actor: { type: "api_key", id: "ak_1" },
        action: "api_key.use",
        result: "denied",
      }),
    );
    expect(harness.values.mock.calls[0]?.[0]).toMatchObject({
      actor_type: "api_key",
      actor_id: "ak_1",
      action: "api_key.use",
      result: "denied",
    });

    await sink.emit(
      makeEvent({
        actor: { type: "system", id: "cron" },
        action: "admin.action",
        result: "failure",
      }),
    );
    expect(harness.values.mock.calls[1]?.[0]).toMatchObject({
      actor_type: "system",
      actor_id: "cron",
      action: "admin.action",
      result: "failure",
    });
  });

  it("rejects when the insert collaborator rejects", async () => {
    const sink = new AuditEventsSink();
    const failure = new Error("auth_events write failed");
    harness.values.mockRejectedValueOnce(failure);
    await expect(sink.emit(makeEvent())).rejects.toBe(failure);
  });

  it("writes independent rows for sequential emits, including the exported singleton", async () => {
    const sink = new AuditEventsSink();
    const first = makeEvent({
      event_id: "0198d3a0-0000-7000-8000-00000000000a",
      actor: { type: "agent", id: "agent-1" },
    });
    const second = makeEvent({
      event_id: "0198d3a0-0000-7000-8000-00000000000b",
      actor: { type: "service", id: "svc-1" },
      result: "failure",
    });

    await sink.emit(first);
    await sink.emit(second);
    await auditEventsSink.emit(
      makeEvent({
        event_id: "0198d3a0-0000-7000-8000-00000000000c",
        actor: { type: "system", id: "system-1" },
      }),
    );

    expect(harness.insert).toHaveBeenCalledTimes(3);
    const rows = harness.values.mock.calls.map((call) => call[0]);
    expect(rows.map((row) => row?.event_id)).toEqual([
      "0198d3a0-0000-7000-8000-00000000000a",
      "0198d3a0-0000-7000-8000-00000000000b",
      "0198d3a0-0000-7000-8000-00000000000c",
    ]);
    expect(rows.map((row) => row?.actor_type)).toEqual([
      "agent",
      "service",
      "system",
    ]);
  });
});
