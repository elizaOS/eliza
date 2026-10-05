import { beforeEach, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

const services = import.meta.dir;
const calls: string[] = [];
const identity = { organizationId: "org", actorId: "actor", commandId: "command" };
const claim = { commandId: "command", leaseToken: "lease", generation: 1 };
let failure = "",
  sessions = 0,
  kind = "schedule_create";
const original = Object.defineProperty({ id: "sub_sched_owned" }, "lastResponse", {
  value: { requestId: "req_original" },
});
const create = mock(async (..._args: unknown[]) => {
  calls.push("create");
  if (failure === "create") throw Error("lost response");
  return original;
});
const observed = mock(async (..._args: unknown[]) => {
  calls.push("observe");
  if (failure === "observe") throw Error("receipt store failed");
  return { id: "effect", state: "observed" };
});
mock.module(
  resolve(import.meta.dir, "../../db/repositories/organization-schedule-effects.ts"),
  () => ({
    readOrganizationScheduleDispatchSource: async () => {
      calls.push("read");
      return {
        effect: { request_payload: { kind } },
        providerBinding: { apiVersion: "2024-11-20.acacia" },
        source: {},
        review: { targetPlanKey: "plus_monthly" },
      };
    },
    markOrganizationScheduleEffectDispatch: async () => {
      calls.push("mark");
      if (failure === "mark") throw Error("lease lost");
      return {
        request_payload: { kind: "schedule_create", subscriptionId: "sub_original" },
        provider_idempotency_key: "original-key",
      };
    },
    recordAuthenticatedOrganizationScheduleEvidence: observed,
  }),
);
mock.module(resolve(import.meta.dir, "organization-downgrade-repreview.ts"), () => ({
  repreviewOrganizationDowngrade: async () => {
    calls.push("repreview");
    if (failure === "repreview") throw Error("financial terms changed");
  },
}));
mock.module(resolve(services, "organization-plan-change-provider-binding.ts"), () => ({
  assertOrganizationPlanChangeProviderBindingCurrent: () => {
    calls.push("catalog");
  },
}));
mock.module(resolve(services, "../runtime/cloud-bindings.ts"), () => ({
  getCloudAwareEnv: () => ({}),
}));
mock.module(resolve(services, "../stripe.ts"), () => ({
  requireStripe: () => ({ subscriptionSchedules: { create } }),
}));
const { dispatchOrganizationScheduleCreate } = await import("./organization-schedule-dispatch");
const run = () =>
  dispatchOrganizationScheduleCreate(identity, claim, "effect", async () => {
    calls.push("session");
    sessions++;
    if (failure === "session" && sessions === 2) throw Error("session revoked");
  });
beforeEach(() => {
  calls.length = 0;
  failure = "";
  sessions = 0;
  kind = "schedule_create";
  create.mockClear();
  observed.mockClear();
});
test("creation follows fresh authority and durable marker with pinned one-shot wire parameters", async () => {
  const result = await run();
  expect(calls).toEqual([
    "session",
    "read",
    "repreview",
    "session",
    "catalog",
    "mark",
    "create",
    "observe",
  ]);
  expect(create.mock.calls).toEqual([
    [
      { from_subscription: "sub_original" },
      { apiVersion: "2024-11-20.acacia", idempotencyKey: "original-key", maxNetworkRetries: 0 },
    ],
  ]);
  expect(observed.mock.calls).toEqual([
    [identity, claim, "effect", { kind: "response", raw: original }],
  ]);
  expect(result.evidence.raw).toBe(original);
  expect(
    Object.getOwnPropertyDescriptor(result.evidence.raw, "lastResponse")?.enumerable,
  ).toBeFalse();
});
test("changed review or revoked session cannot mark or dispatch a schedule", async () => {
  for (const step of ["repreview", "session"]) {
    calls.length = 0;
    sessions = 0;
    failure = step;
    await expect(run()).rejects.toThrow();
    expect(calls).not.toContain("mark");
    expect(create).not.toHaveBeenCalled();
  }
});
test("lost lease before marker commit cannot dispatch", async () => {
  failure = "mark";
  await expect(run()).rejects.toThrow("lease lost");
  expect(create).not.toHaveBeenCalled();
  expect(observed).not.toHaveBeenCalled();
});
test("lost provider response remains unknown without local retry or invented receipt", async () => {
  failure = "create";
  await expect(run()).rejects.toThrow("lost response");
  expect(create).toHaveBeenCalledTimes(1);
  expect(observed).not.toHaveBeenCalled();
  expect(calls.filter((c) => c === "mark")).toHaveLength(1);
});
test("receipt persistence failure cannot repeat a completed provider write", async () => {
  failure = "observe";
  await expect(run()).rejects.toThrow("receipt store failed");
  expect(create).toHaveBeenCalledTimes(1);
  expect(observed).toHaveBeenCalledTimes(1);
});
test("configuration effect cannot enter initial creation dispatcher", async () => {
  kind = "schedule_configure";
  await expect(run()).rejects.toThrow();
  expect(calls).not.toContain("repreview");
  expect(create).not.toHaveBeenCalled();
});
