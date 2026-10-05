import { expect, test } from "bun:test";
import {
  oneMonthlySchedulePhaseEnd,
  proveOrganizationScheduleConfiguration,
} from "./organization-schedule-configuration-proof";
import { configurationProofTestInput as proofInput } from "./organization-schedule-configuration-test-fixture";
import { projectOriginalScheduleResponse } from "./organization-schedule-effect-origin";

test("exact attributed configuration and unchanged current terms produce private proof", () => {
  const f = proofInput(),
    proof = proveOrganizationScheduleConfiguration(f);
  expect(proof.scheduleId).toBe("sub_sched_owned");
  expect(proof.effectiveAt).toBe(200);
  expect(proof.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
});
test("calendar phase duration clamps month ends without changing UTC time", () => {
  for (const [start, end] of [
    ["2025-01-31T12:30:00Z", "2025-02-28T12:30:00Z"],
    ["2024-01-31T12:30:00Z", "2024-02-29T12:30:00Z"],
    ["2025-12-31T23:00:00Z", "2026-01-31T23:00:00Z"],
  ])
    expect(oneMonthlySchedulePhaseEnd(Date.parse(start!) / 1000)).toBe(Date.parse(end!) / 1000);
});
test("later retrieval cannot replace the original configured response", () => {
  const f = proofInput();
  f.rawCurrentSchedule.phases[1]!.end_date = 201;
  expect(() => proveOrganizationScheduleConfiguration(f)).toThrow();
});
test("attributed but unapplied or incorrect configuration does not prove success", () => {
  for (const mutate of [
    (s: ReturnType<typeof proofInput>["rawCurrentSchedule"]) => {
      s.phases[1]!.end_date = 201;
    },
    (s: ReturnType<typeof proofInput>["rawCurrentSchedule"]) => {
      s.phases[1]!.items[0]!.price = "price_foreign";
    },
    (s: ReturnType<typeof proofInput>["rawCurrentSchedule"]) => {
      s.phases.pop();
    },
  ]) {
    const f = proofInput();
    mutate(f.rawCurrentSchedule);
    const raw = Object.defineProperty(structuredClone(f.rawCurrentSchedule), "lastResponse", {
      value: {
        requestId: "req_configured",
        statusCode: 200,
        apiVersion: "2024-11-20.acacia",
        idempotencyKey: "configure-key",
      },
    });
    f.originalConfiguration.evidence.raw = raw;
    f.originalConfiguration.originalReceipt = projectOriginalScheduleResponse({
      raw,
      originalRequest: f.originalConfiguration.originalRequest,
      observedAt: f.originalConfiguration.observedAt,
    });
    expect(() => proveOrganizationScheduleConfiguration(f)).toThrow();
  }
});
test("current subscription or inherited customer drift blocks proof", () => {
  const f = proofInput();
  f.rawSubscription.default_payment_method = "pm_changed";
  expect(() => proveOrganizationScheduleConfiguration(f)).toThrow();
  const g = proofInput();
  g.rawCustomer.balance = -100;
  expect(() => proveOrganizationScheduleConfiguration(g)).toThrow();
});

test("an attributed durable request cannot substitute future retained payment settings", () => {
  const f = proofInput();
  Object.assign(f.originalConfiguration.originalRequest.request.params.phases[1], {
    default_payment_method: "pm_substituted",
  });
  Object.assign(f.rawCurrentSchedule.phases[1]!, { default_payment_method: "pm_substituted" });
  const raw = Object.defineProperty(structuredClone(f.rawCurrentSchedule), "lastResponse", {
    value: {
      requestId: "req_configured",
      statusCode: 200,
      apiVersion: "2024-11-20.acacia",
      idempotencyKey: "configure-key",
    },
  });
  f.originalConfiguration.evidence.raw = raw;
  f.originalConfiguration.originalReceipt = projectOriginalScheduleResponse({
    raw,
    originalRequest: f.originalConfiguration.originalRequest,
    observedAt: f.originalConfiguration.observedAt,
  });
  expect(() => proveOrganizationScheduleConfiguration(f)).toThrow();
});
