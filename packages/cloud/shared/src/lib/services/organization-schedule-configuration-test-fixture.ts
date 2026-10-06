import { oneMonthlySchedulePhaseEnd } from "./organization-schedule-configuration-proof";
import { projectOriginalScheduleResponse } from "./organization-schedule-effect-origin";
import { mapOrganizationDowngradeSchedulePhases } from "./organization-schedule-phase-mapping";
import { originalScheduleTestInput as input } from "./organization-schedule-provider-test-fixture";

export function configurationProofTestInput() {
  const f = input(),
    request = mapOrganizationDowngradeSchedulePhases(f);
  if (request.kind !== "schedule_configure") throw Error("Expected configure");
  const snapshot = {
    ...f.rawCurrentSchedule,
    phases: request.params.phases.map((p, i) => ({
      ...f.rawCurrentSchedule.phases[0],
      ...p,
      end_date: i === 0 ? p.end_date : oneMonthlySchedulePhaseEnd(p.start_date),
      items: p.items.map((item) => ({
        ...(f.rawCurrentSchedule.phases[0]!.items as Record<string, unknown>[])[0],
        ...item,
        plan: item.price,
      })),
    })),
  };
  for (const p of snapshot.phases) Reflect.deleteProperty(p, "iterations");
  const raw = Object.defineProperty(structuredClone(snapshot), "lastResponse", {
    value: {
      requestId: "req_configured",
      statusCode: 200,
      apiVersion: "2024-11-20.acacia",
      idempotencyKey: "configure-key",
    },
  });
  const originalRequest = {
    ...f.originalRequest,
    request,
    startedAt: new Date(120000),
    providerIdempotencyKey: "configure-key",
  };
  const originalReceipt = projectOriginalScheduleResponse({
    raw,
    originalRequest,
    observedAt: f.observedAt,
  });
  return {
    originalCreate: f,
    originalConfiguration: {
      originalReceipt,
      originalRequest,
      evidence: { kind: "response" as const, raw },
      observedAt: f.observedAt,
    },
    rawCurrentSchedule: snapshot,
    rawSubscription: f.rawSubscription,
    rawCustomer: f.rawCustomer,
    originalTerms: f.originalTerms,
  };
}
