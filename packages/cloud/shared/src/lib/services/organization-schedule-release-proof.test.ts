import { expect, test } from "bun:test";
import { organizationScheduleEffectRequestSchema } from "./organization-schedule-effect-contract";
import {
  projectAuthenticatedScheduleEvent,
  projectOriginalScheduleResponse,
} from "./organization-schedule-effect-origin";
import { originalScheduleTestInput } from "./organization-schedule-provider-test-fixture";
import { proveOrganizationScheduleRelease } from "./organization-schedule-release-proof";

function fixture() {
  const f = originalScheduleTestInput();
  const snapshot = {
    ...f.rawCurrentSchedule,
    status: "released",
    subscription: null,
    released_subscription: "sub_original",
    released_at: 160,
    current_phase: null,
  };
  const transport = {
    requestId: "req_release",
    statusCode: 200,
    apiVersion: "2024-11-20.acacia",
    idempotencyKey: "release-original",
  };
  const raw = Object.defineProperty(structuredClone(snapshot), "lastResponse", {
    value: transport,
  });
  const originalRequest = {
    ...f.originalRequest,
    request: {
      kind: "schedule_release" as const,
      scheduleId: "sub_sched_owned",
      params: { preserve_cancel_date: true as const },
    },
    providerIdempotencyKey: "release-original",
    startedAt: new Date(155000),
  };
  const observedAt = new Date(170000),
    originalReceipt = projectOriginalScheduleResponse({ raw, originalRequest, observedAt });
  return {
    originalCreate: f,
    originalRelease: {
      originalReceipt,
      originalRequest,
      evidence: { kind: "response" as const, raw },
      observedAt,
    },
    rawCurrentSchedule: snapshot,
    rawSubscription: { ...f.rawSubscription, schedule: null },
    rawCustomer: f.rawCustomer,
    originalTerms: f.originalTerms,
    event: {
      id: "evt_release",
      object: "event",
      type: "subscription_schedule.released",
      api_version: "2024-11-20.acacia",
      created: 160,
      livemode: false,
      request: { id: "req_release", idempotency_key: "release-original" },
      data: { object: snapshot },
    },
  };
}
test("owned release retains original subscription and financial settings", () => {
  const f = fixture();
  expect(proveOrganizationScheduleRelease(f).scheduleId).toBe("sub_sched_owned");
  const event = projectAuthenticatedScheduleEvent({
    raw: f.event,
    originalRequest: f.originalRelease.originalRequest,
    observedAt: f.originalRelease.observedAt,
  });
  expect(event.subscriptionId).toBe("sub_original");
  expect(event.eventId).toBe("evt_release");
});
test("foreign or non-release lifecycle is not original release evidence", () => {
  for (const change of [
    { status: "active" },
    { released_subscription: "sub_foreign" },
    { subscription: "sub_original" },
    { released_at: null },
    { released_at: 154 },
    { released_at: 171 },
    { current_phase: { start_date: 100, end_date: 200 } },
  ]) {
    const f = fixture();
    Object.assign(f.event.data.object, change);
    expect(() =>
      projectAuthenticatedScheduleEvent({
        raw: f.event,
        originalRequest: f.originalRelease.originalRequest,
        observedAt: f.originalRelease.observedAt,
      }),
    ).toThrow();
  }
});
test("release event chronology and request kind cannot be substituted", () => {
  const f = fixture();
  f.event.created = 159;
  expect(() =>
    projectAuthenticatedScheduleEvent({
      raw: f.event,
      originalRequest: f.originalRelease.originalRequest,
      observedAt: f.originalRelease.observedAt,
    }),
  ).toThrow();
  f.event.created = 160;
  f.event.type = "subscription_schedule.updated";
  expect(() =>
    projectAuthenticatedScheduleEvent({
      raw: f.event,
      originalRequest: f.originalRelease.originalRequest,
      observedAt: f.originalRelease.observedAt,
    }),
  ).toThrow();
});
test("release cannot hide changed defaults, phase terms or remaining attachment", () => {
  for (const field of ["defaults", "phase", "attachment"]) {
    const f = fixture();
    if (field === "defaults")
      f.rawCurrentSchedule.default_settings.default_payment_method = "pm_changed";
    if (field === "phase") f.rawCurrentSchedule.phases = [];
    if (field === "attachment") Object.assign(f.rawSubscription, { schedule: "sub_sched_owned" });
    expect(() => proveOrganizationScheduleRelease(f)).toThrow();
  }
});
test("matching release response still cannot alter original financial settings", () => {
  const f = fixture();
  f.rawCurrentSchedule.default_settings.description = "Changed";
  const raw = Object.defineProperty(structuredClone(f.rawCurrentSchedule), "lastResponse", {
    value: {
      requestId: "req_release",
      statusCode: 200,
      apiVersion: "2024-11-20.acacia",
      idempotencyKey: "release-original",
    },
  });
  f.originalRelease.evidence.raw = raw;
  f.originalRelease.originalReceipt = projectOriginalScheduleResponse({
    raw,
    originalRequest: f.originalRelease.originalRequest,
    observedAt: f.originalRelease.observedAt,
  });
  expect(() => proveOrganizationScheduleRelease(f)).toThrow();
});

test("compensation request cannot silently discard an existing cancellation date", () => {
  const request = {
    kind: "schedule_release",
    scheduleId: "sub_sched_owned",
    params: { preserve_cancel_date: true },
  };
  expect(organizationScheduleEffectRequestSchema.parse(request)).toEqual(request);
  for (const params of [
    {},
    { preserve_cancel_date: false },
    { preserve_cancel_date: true, extra: "override" },
  ])
    expect(() => organizationScheduleEffectRequestSchema.parse({ ...request, params })).toThrow();
});
