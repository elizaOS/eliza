import { expect, test } from "bun:test";
import {
  projectAuthenticatedScheduleEvent,
  projectOriginalScheduleResponse,
} from "./organization-schedule-effect-origin";

function fixture() {
  const schedule = {
    id: "sub_sched_owned",
    object: "subscription_schedule",
    customer: "cus_original",
    subscription: "sub_original",
    livemode: false,
    created: 101,
    application: null,
    status: "active",
    canceled_at: null,
    completed_at: null,
    released_at: null,
    released_subscription: null,
    end_behavior: "release",
    current_phase: { start_date: 50, end_date: 200 },
    phases: [{ start_date: 50, end_date: 200, items: [{ price: "price_pro", quantity: 1 }] }],
    default_settings: { default_payment_method: "pm_original" },
  };
  const transport = {
    requestId: "req_original",
    statusCode: 200,
    apiVersion: "2024-11-20.acacia",
    idempotencyKey: "original-create",
  };
  return {
    schedule,
    transport,
    originalRequest: {
      request: { kind: "schedule_create" as const, subscriptionId: "sub_original" },
      providerIdempotencyKey: "original-create",
      customerId: "cus_original",
      subscriptionId: "sub_original",
      livemode: false,
      startedAt: new Date(100500),
    },
    observedAt: new Date(110000),
    event: {
      id: "evt_original",
      object: "event",
      type: "subscription_schedule.created",
      api_version: "2024-11-20.acacia",
      created: 102,
      livemode: false,
      request: { id: "req_original", idempotency_key: "original-create" },
      data: { object: schedule },
    },
  };
}
function response(f = fixture()) {
  return projectOriginalScheduleResponse({
    ...f,
    raw: Object.defineProperty(f.schedule, "lastResponse", { value: f.transport }),
  });
}
function event(f = fixture()) {
  return projectAuthenticatedScheduleEvent({ ...f, raw: f.event });
}
test("original response retains non-enumerable SDK attribution and no transport secrets", () => {
  const f = fixture();
  Object.assign(f.transport, { headers: { authorization: "private-header" } });
  const receipt = response(f);
  expect(receipt.providerRequestId).toBe("req_original");
  expect(receipt.scheduleId).toBe("sub_sched_owned");
  expect(receipt.kind).toBe("response");
  expect(receipt.eventId).toBeNull();
  expect(JSON.stringify(receipt)).not.toContain("private-header");
  expect(receipt.evidenceDigest).toBe(response().evidenceDigest);
});
test("authenticated create event preserves original identity", () => {
  const receipt = event();
  expect(receipt.kind).toBe("event");
  expect(receipt.eventId).toBe("evt_original");
  expect(receipt.providerIdempotencyKey).toBe("original-create");
  expect(receipt.subscriptionId).toBe("sub_original");
});
test("matching subscription pointer without original POST metadata is insufficient", () => {
  const f = fixture();
  expect(() => projectOriginalScheduleResponse({ ...f, raw: f.schedule })).toThrow();
  for (const key of ["requestId", "apiVersion", "idempotencyKey"]) {
    const next = fixture();
    Reflect.deleteProperty(next.transport, key);
    expect(() => response(next)).toThrow();
  }
});
test("foreign transport, API version and failed responses do not prove an effect", () => {
  for (const change of [
    { idempotencyKey: "another-command" },
    { stripeAccount: "acct_foreign" },
    { apiVersion: "2025-03-31.basil" },
    { requestId: "not-a-request" },
    { statusCode: 500 },
  ]) {
    const f = fixture();
    Object.assign(f.transport, change);
    expect(() => response(f)).toThrow();
  }
});
test("schedule tenant, mode and lifecycle scope cannot be borrowed", () => {
  for (const change of [
    { customer: "cus_foreign" },
    { subscription: "sub_foreign" },
    { livemode: true },
    { application: "ca_foreign" },
    { status: "released" },
    { released_subscription: "sub_original" },
    { canceled_at: 105 },
    { completed_at: 105 },
    { released_at: 105 },
    { created: 99 },
    { created: 111 },
    { current_phase: { start_date: 200, end_date: 200 } },
  ]) {
    const f = fixture();
    Object.assign(f.schedule, change);
    expect(() => response(f)).toThrow();
    expect(() => event(f)).toThrow();
  }
});
test("automated, foreign and wrong-kind events are not original create evidence", () => {
  for (const change of [
    { request: null },
    { request: { id: "req_original", idempotency_key: null } },
    { request: { id: "req_foreign", idempotency_key: "foreign-command" } },
    { type: "subscription_schedule.updated" },
    { type: "subscription_schedule.released" },
    { account: "acct_foreign" },
    { context: "foreign-context" },
    { livemode: true },
    { api_version: "2025-03-31.basil" },
    { created: 99 },
    { created: 111 },
  ]) {
    const f = fixture();
    Object.assign(f.event, change);
    expect(() => event(f)).toThrow();
  }
});
test("invalid observation and dispatch times cannot yield receipts", () => {
  for (const date of [new Date(Number.NaN), new Date(-1000), new Date(120000)]) {
    const f = fixture();
    f.originalRequest.startedAt = date;
    expect(() => response(f)).toThrow();
    expect(() => event(f)).toThrow();
  }
  const f = fixture();
  f.observedAt = new Date(Number.NaN);
  expect(() => response(f)).toThrow();
  expect(() => event(f)).toThrow();
});
test("full financial snapshot changes alter evidence while later observation retains its digest", () => {
  const baseline = event();
  const changed = fixture();
  changed.schedule.default_settings.default_payment_method = "pm_changed";
  expect(event(changed).evidenceDigest).not.toBe(baseline.evidenceDigest);
  const later = fixture();
  later.observedAt = new Date(300000);
  expect(event(later).evidenceDigest).toBe(baseline.evidenceDigest);
  expect(event(later).observedAt).not.toBe(baseline.observedAt);
});
test("configure attribution binds the original create schedule and exact update request", () => {
  const f = fixture();
  const originalRequest = {
    ...f.originalRequest,
    startedAt: new Date(105000),
    providerIdempotencyKey: "original-configure",
    request: {
      kind: "schedule_configure" as const,
      scheduleId: "sub_sched_owned",
      params: {
        end_behavior: "release" as const,
        proration_behavior: "none" as const,
        phases: [
          {
            start_date: 50,
            end_date: 200,
            items: [{ price: "price_pro", quantity: 1 as const }],
            proration_behavior: "none" as const,
          },
          {
            start_date: 200,
            iterations: 1 as const,
            items: [{ price: "price_plus", quantity: 1 as const }],
            proration_behavior: "none" as const,
          },
        ] as [
          {
            start_date: number;
            end_date: number;
            items: { price: string; quantity: 1 }[];
            proration_behavior: "none";
          },
          {
            start_date: number;
            iterations: 1;
            items: { price: string; quantity: 1 }[];
            proration_behavior: "none";
          },
        ],
      },
    },
  };
  const raw = {
    ...f.event,
    type: "subscription_schedule.updated",
    created: 106,
    request: { id: "req_configure", idempotency_key: "original-configure" },
  };
  const project = () =>
    projectAuthenticatedScheduleEvent({ raw, originalRequest, observedAt: f.observedAt });
  expect(project().providerRequestId).toBe("req_configure");
  // This proves attribution only; unchanged phases are not configuration success.
  expect(project().scheduleId).toBe("sub_sched_owned");
  originalRequest.request.scheduleId = "sub_sched_foreign";
  expect(project).toThrow();
  originalRequest.request.scheduleId = "sub_sched_owned";
  raw.created = 104;
  expect(project).toThrow();
});
