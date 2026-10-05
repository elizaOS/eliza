import { beforeEach, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

const calls: string[] = [];
const identity = { organizationId: "org", actorId: "actor", commandId: "command" },
  claim = { commandId: "command", leaseToken: "lease", generation: 2 };
const create = {
  id: "create",
  kind: "schedule_create",
  state: "observed",
  started_at: new Date(100000),
  receipt: { kind: "response", scheduleId: "sub_sched_owned" },
  request_payload: { kind: "schedule_create", subscriptionId: "sub_original" },
  provider_idempotency_key: "create-key",
  customer_id: "cus_original",
  subscription_id: "sub_original",
  livemode: false,
};
const releaseBase = {
  ...create,
  id: "release",
  kind: "schedule_release",
  state: "ready",
  started_at: new Date(120000),
  request_payload: {
    kind: "schedule_release",
    scheduleId: "sub_sched_owned",
    params: { preserve_cancel_date: true },
  },
  provider_idempotency_key: "release-key",
};
let releaseState: typeof releaseBase | null = null,
  failure = "",
  observations = 0;
const raw = Object.defineProperty({ id: "sub_sched_owned", status: "released" }, "lastResponse", {
  value: { requestId: "req_release" },
});
const release = mock(async (..._args: unknown[]) => {
  calls.push("release");
  if (failure === "release") throw Error("lost release response");
  return raw;
});
const record = mock(async (...args: unknown[]) => {
  calls.push("record");
  if (failure === "record") throw Error("receipt failed");
  const evidence = args[3] as { kind: string };
  releaseState = {
    ...releaseBase,
    state: "observed",
    receipt: { kind: evidence.kind, scheduleId: "sub_sched_owned" },
  };
  return releaseState;
});
const proof = mock((..._args: unknown[]) => {
  calls.push("proof");
  if (failure === "proof") throw Error("financial drift");
  return { scheduleId: "sub_sched_owned" };
});
const search = mock(async (input: { originalRequest: { request: { kind: string } } }) => {
  calls.push(`search:${input.originalRequest.request.kind}`);
  if (failure === "search") throw Error("history unavailable");
  return { raw: { kind: input.originalRequest.request.kind } };
});
mock.module(
  resolve(import.meta.dir, "../../db/repositories/organization-schedule-effects.ts"),
  () => ({
    readOrganizationScheduleCompensationSource: async () => {
      calls.push("authority");
      return {
        create,
        release: releaseState,
        retainedTerms: { version: 1 },
        providerBinding: { apiVersion: "2024-11-20.acacia" },
      };
    },
    prepareOrganizationScheduleCompensation: async () => {
      calls.push("stage");
      releaseState = { ...releaseBase };
      return releaseState;
    },
    markOrganizationScheduleCompensationDispatch: async () => {
      calls.push("mark");
      if (failure === "mark") throw Error("lease lost");
      releaseState = { ...releaseBase, state: "started" };
      return releaseState;
    },
    recordAuthenticatedOrganizationScheduleEvidence: record,
  }),
);
mock.module(resolve(import.meta.dir, "organization-schedule-attached-terms.ts"), () => ({
  assertOrganizationScheduleAttachedTermsCurrent: () => {
    calls.push("retained");
    if (++observations === 2 && failure === "drift") throw Error("terms changed");
  },
}));
mock.module(resolve(import.meta.dir, "organization-schedule-event-search.ts"), () => ({
  findOriginalScheduleEvent: search,
}));
mock.module(resolve(import.meta.dir, "organization-schedule-release-proof.ts"), () => ({
  proveOrganizationScheduleRelease: proof,
}));
mock.module(resolve(import.meta.dir, "../stripe.ts"), () => ({
  requireStripe: () => ({
    events: {},
    customers: {
      retrieve: async () => {
        calls.push("customer");
        return {};
      },
    },
    subscriptions: {
      retrieve: async () => {
        calls.push("subscription");
        return {};
      },
    },
    subscriptionSchedules: {
      retrieve: async () => {
        calls.push("schedule");
        return {};
      },
      release,
    },
  }),
}));
const { compensateOrganizationScheduleCreate, recoverOrganizationScheduleCompensation } =
  await import("./organization-schedule-compensation");
const execute = () =>
  compensateOrganizationScheduleCreate(identity, claim, { kind: "response", raw: {} });
const recover = () => recoverOrganizationScheduleCompensation(identity, claim);
beforeEach(() => {
  calls.length = 0;
  releaseState = null;
  failure = "";
  observations = 0;
  release.mockClear();
  record.mockClear();
  proof.mockClear();
  search.mockClear();
});
test("cleanup rechecks retained terms twice, marks once and preserves cancellation date", async () => {
  await execute();
  expect(observations).toBe(2);
  expect(calls.indexOf("retained")).toBeLessThan(calls.indexOf("stage"));
  expect(calls.lastIndexOf("retained")).toBeLessThan(calls.indexOf("mark"));
  expect(calls.indexOf("mark")).toBeLessThan(calls.indexOf("release"));
  expect(release.mock.calls).toEqual([
    [
      "sub_sched_owned",
      { preserve_cancel_date: true },
      { apiVersion: "2024-11-20.acacia", idempotencyKey: "release-key", maxNetworkRetries: 0 },
    ],
  ]);
  expect(record.mock.calls).toEqual([[identity, claim, "release", { kind: "response", raw }]]);
  expect(proof).toHaveBeenCalledTimes(1);
});
test("terms changing after staging block the irreversible release marker", async () => {
  failure = "drift";
  await expect(execute()).rejects.toThrow("terms changed");
  expect(calls).toContain("stage");
  expect(calls).not.toContain("mark");
  expect(release).not.toHaveBeenCalled();
});
test("lost lease blocks release", async () => {
  failure = "mark";
  await expect(execute()).rejects.toThrow("lease lost");
  expect(release).not.toHaveBeenCalled();
});
test("lost release response never retries or invents receipt", async () => {
  failure = "release";
  await expect(execute()).rejects.toThrow("lost release response");
  expect(release).toHaveBeenCalledTimes(1);
  expect(record).not.toHaveBeenCalled();
  expect(proof).not.toHaveBeenCalled();
});
test("receipt or post-release proof failure cannot cause another release", async () => {
  for (const step of ["record", "proof"]) {
    failure = step;
    observations = 0;
    release.mockClear();
    await expect(execute()).rejects.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
  }
});
test("unknown release recovery finds original events and retains event receipt without POST", async () => {
  releaseState = { ...releaseBase, state: "started" };
  await recover();
  expect(calls.filter((c) => c.startsWith("search:"))).toEqual([
    "search:schedule_create",
    "search:schedule_release",
  ]);
  expect(record.mock.calls).toEqual([
    [identity, claim, "release", { kind: "event", raw: { kind: "schedule_release" } }],
  ]);
  expect(release).not.toHaveBeenCalled();
  expect(calls).not.toContain("mark");
  expect(calls).not.toContain("stage");
  expect(proof).toHaveBeenCalledTimes(1);
});
test("observed response recovery uses supplemental event proof without replacing receipt", async () => {
  releaseState = { ...releaseBase, state: "observed" };
  const original = releaseState.receipt;
  await recover();
  expect(record).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  const input = proof.mock.calls[0]![0] as {
    originalRelease: { originalReceipt: unknown; evidence: { kind: string } };
  };
  expect(input.originalRelease.originalReceipt).toBe(original);
  expect(input.originalRelease.evidence.kind).toBe("event");
});
test("unstarted release is not a lost-response recovery", async () => {
  releaseState = { ...releaseBase, state: "ready" };
  await expect(recover()).rejects.toThrow();
  expect(search).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
});
test("missing history preserves uncertainty without provider writes", async () => {
  releaseState = { ...releaseBase, state: "started" };
  failure = "search";
  await expect(recover()).rejects.toThrow("history unavailable");
  expect(release).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
  expect(proof).not.toHaveBeenCalled();
});
