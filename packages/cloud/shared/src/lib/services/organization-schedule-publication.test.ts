import { beforeEach, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

const source = resolve(import.meta.dir, "../..");
let context: unknown;
let failEvent = false,
  failFinalize = false;
const calls: string[] = [];
let resultInput: unknown;
mock.module(resolve(source, "db/repositories/organization-schedule-effects.ts"), () => ({
  readOrganizationSchedulePublicationSource: async () => {
    calls.push("context");
    return context;
  },
  recordAuthenticatedOrganizationScheduleEvidence: async () => {
    calls.push("receipt");
  },
}));
mock.module(resolve(source, "db/repositories/organization-schedule-finalization.ts"), () => ({
  finalizeConfiguredOrganizationSchedule: async (input: unknown) => {
    calls.push("finalize");
    resultInput = input;
    if (failFinalize) throw Error("lease lost");
    return { command: { status: "APPLIED" }, replayed: false };
  },
}));
mock.module(resolve(source, "lib/services/organization-schedule-event-search.ts"), () => ({
  findOriginalScheduleEvent: async (input: {
    originalRequest: { providerIdempotencyKey: string };
  }) => {
    calls.push("event:" + input.originalRequest.providerIdempotencyKey);
    if (failEvent) throw Error("history unavailable");
    return { raw: { key: input.originalRequest.providerIdempotencyKey } };
  },
}));
mock.module(resolve(source, "lib/stripe.ts"), () => ({
  requireStripe: () => {
    calls.push("stripe");
    return {
      events: {},
      customers: {
        retrieve: async (...args: unknown[]) => {
          calls.push("customer");
          expect(args).toEqual([
            "cus_owned",
            { expand: ["tax_ids"] },
            { apiVersion: "2024-11-20.acacia" },
          ]);
          return { id: "cus_owned" };
        },
      },
      subscriptions: {
        retrieve: async () => {
          calls.push("subscription");
          return { id: "sub_owned" };
        },
      },
      subscriptionSchedules: {
        retrieve: async () => {
          calls.push("schedule");
          return { id: "sub_sched_owned" };
        },
        update: () => {
          throw Error("unexpected financial write");
        },
        release: () => {
          throw Error("unexpected financial write");
        },
        create: () => {
          throw Error("unexpected financial write");
        },
      },
    };
  },
}));
const { observeAndFinalizeOrganizationScheduleConfiguration: run } = await import(
  "./organization-schedule-publication"
);
const identity = { organizationId: "organization", actorId: "actor", commandId: "command" };
const claim = { commandId: "command", leaseToken: "lease", generation: 4 };
beforeEach(() => {
  calls.length = 0;
  failEvent = false;
  failFinalize = false;
  resultInput = null;
  const base = {
    customer_id: "cus_owned",
    subscription_id: "sub_owned",
    livemode: false,
    started_at: new Date(),
    receipt: { scheduleId: "sub_sched_owned" },
  };
  context = {
    kind: "observe",
    apiVersion: "2024-11-20.acacia",
    create: {
      ...base,
      id: "create",
      state: "observed",
      provider_idempotency_key: "create-key",
      request_payload: { kind: "schedule_create" },
    },
    configuration: {
      ...base,
      id: "configure",
      state: "started",
      provider_idempotency_key: "configure-key",
      request_payload: { kind: "schedule_configure" },
    },
  };
});
test("direct attributed evidence records receipt and freshly observes state before finalization", async () => {
  const evidence = {
    create: { kind: "response" as const, raw: { direct: "create" } },
    configuration: { kind: "response" as const, raw: { direct: "configure" } },
  };
  expect((await run(identity, claim, evidence)).command.status).toBe("APPLIED");
  expect(calls).toEqual([
    "context",
    "stripe",
    "receipt",
    "customer",
    "subscription",
    "schedule",
    "finalize",
  ]);
  expect(resultInput).toMatchObject({
    ...identity,
    leaseToken: "lease",
    executionGeneration: 4,
    createEvidence: evidence.create,
    configurationEvidence: evidence.configuration,
  });
});
test("lost configuration response uses original event attribution and no provider mutation", async () => {
  await run(identity, claim);
  expect(calls).toEqual([
    "context",
    "stripe",
    "event:create-key",
    "event:configure-key",
    "receipt",
    "customer",
    "subscription",
    "schedule",
    "finalize",
  ]);
  expect((resultInput as { configurationEvidence: unknown }).configurationEvidence).toEqual({
    kind: "event",
    raw: { key: "configure-key" },
  });
});
test("existing response receipt is not replaced by a supplemental event", async () => {
  (context as { configuration: { state: string } }).configuration.state = "observed";
  await run(identity, claim);
  expect(calls).not.toContain("receipt");
  expect(calls).toContain("finalize");
});
test("missing original history preserves uncertainty without state reads or publication", async () => {
  failEvent = true;
  await expect(run(identity, claim)).rejects.toThrow("history unavailable");
  expect(calls).toEqual(["context", "stripe", "event:create-key"]);
});
test("finalizer lease rejection never triggers another provider operation", async () => {
  failFinalize = true;
  await expect(run(identity, claim)).rejects.toThrow("lease lost");
  expect(calls.filter((c) => c === "receipt")).toHaveLength(1);
  expect(calls.filter((c) => c === "finalize")).toHaveLength(1);
});
test("immutable terminal result replays without any provider access", async () => {
  context = { kind: "terminal", command: { status: "APPLIED" } };
  expect(await run(identity, claim)).toEqual({ command: { status: "APPLIED" }, replayed: true });
  expect(calls).toEqual(["context"]);
});
