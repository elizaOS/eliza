import { beforeEach, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { scheduleEffectRequestDigest } from "./organization-schedule-effect-contract";

const services = import.meta.dir;
const calls: string[] = [];
const identity = { organizationId: "org", actorId: "actor", commandId: "command" },
  claim = { commandId: "command", leaseToken: "lease", generation: 1 };
const request = {
  kind: "schedule_configure" as const,
  scheduleId: "sub_sched_owned",
  params: {
    end_behavior: "release" as const,
    proration_behavior: "none" as const,
    phases: [
      {
        start_date: 100,
        end_date: 200,
        proration_behavior: "none" as const,
        items: [{ price: "price_pro", quantity: 1 as const }],
      },
      {
        start_date: 200,
        iterations: 1 as const,
        proration_behavior: "none" as const,
        items: [{ price: "price_plus", quantity: 1 as const }],
      },
    ] as [
      {
        start_date: number;
        end_date: number;
        proration_behavior: "none";
        items: { price: string; quantity: 1 }[];
      },
      {
        start_date: number;
        iterations: 1;
        proration_behavior: "none";
        items: { price: string; quantity: 1 }[];
      },
    ],
  },
};
let failure = "",
  sessions = 0,
  storedDigest = "";
const review = {
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  observedAt: new Date().toISOString(),
  targetPlanKey: "plus_monthly",
};
const create = {
  kind: "schedule_create",
  state: "observed",
  receipt: { scheduleId: "sub_sched_owned" },
  started_at: new Date(),
  request_payload: { kind: "schedule_create", subscriptionId: "sub_original" },
  provider_idempotency_key: "create-key",
  customer_id: "cus_original",
  subscription_id: "sub_original",
  livemode: false,
};
const captured = () => ({
  source: {
    stripe_customer_id: "cus_original",
    stripe_subscription_id: "sub_original",
    stripe_subscription_item_id: "si_original",
  },
  review,
  providerBinding: { apiVersion: "2024-11-20.acacia", targetPriceId: "price_plus" },
  retainedTerms: {},
  predecessor: create,
  effect: { kind: "schedule_configure", request_digest: storedDigest },
});
const updated = Object.defineProperty({ id: "sub_sched_owned" }, "lastResponse", {
  value: { requestId: "req_update" },
});
const update = mock(async (..._args: unknown[]) => {
  calls.push("update");
  if (failure === "update") throw Error("lost update response");
  return updated;
});
const preview = mock(async (..._args: unknown[]) => {
  calls.push("preview");
  return {};
});
const stage = mock(async (..._args: unknown[]) => {
  calls.push("stage");
  return { id: "configure" };
});
const record = mock(async (..._args: unknown[]) => {
  calls.push("record");
  return { id: "configure", state: "observed" };
});
mock.module(
  resolve(import.meta.dir, "../../db/repositories/organization-schedule-effects.ts"),
  () => ({
    readOrganizationScheduleConfigurationSource: async () => {
      calls.push("read-create");
      return { ...captured(), effect: create };
    },
    readOrganizationScheduleDispatchSource: async () => {
      calls.push("read-config");
      return captured();
    },
    prepareOrganizationScheduleConfiguration: stage,
    markOrganizationScheduleEffectDispatch: async () => {
      calls.push("mark");
      if (failure === "mark") throw Error("lease lost");
      return { request_payload: request, provider_idempotency_key: "configure-key" };
    },
    recordAuthenticatedOrganizationScheduleEvidence: record,
  }),
);
mock.module(resolve(import.meta.dir, "organization-schedule-phase-mapping.ts"), () => ({
  mapOrganizationDowngradeSchedulePhases: () => {
    calls.push("map");
    if (failure === "map") throw Error("terms changed");
    return request;
  },
}));
mock.module(resolve(services, "organization-plan-change-provider-binding.ts"), () => ({
  assertOrganizationPlanChangeProviderBindingCurrent: () => {
    calls.push("binding");
  },
}));
mock.module(resolve(services, "organization-downgrade-review.ts"), () => ({
  projectOrganizationDowngradeReview: () =>
    failure === "review" ? { ...review, targetPlanKey: "changed" } : review,
}));
mock.module(resolve(services, "subscription-catalog.ts"), () => ({
  adaptStripeSubscriptionCatalogProvider: () => ({}),
  getVerifiedSubscriptionPlans: async () => {
    calls.push("catalog");
  },
}));
mock.module(resolve(services, "../runtime/cloud-bindings.ts"), () => ({
  getCloudAwareEnv: () => ({}),
}));
mock.module(resolve(services, "../stripe.ts"), () => ({
  requireStripe: () => ({
    events: {
      list: async () => {
        throw Error("unexpected search");
      },
    },
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
      update,
    },
    invoices: { createPreview: preview },
  }),
}));
const publish = mock(async (..._args: unknown[]) => {
  calls.push("publish");
  if (failure === "publish") throw Error("publication unavailable");
  return { command: { status: "APPLIED" }, replayed: false };
});
mock.module(resolve(services, "organization-schedule-publication.ts"), () => ({
  observeAndFinalizeOrganizationScheduleConfiguration: publish,
}));
const {
  prepareObservedOrganizationScheduleConfiguration,
  dispatchOrganizationScheduleConfiguration,
} = await import("./organization-schedule-configuration");
const session = async () => {
  calls.push("session");
  if (++sessions === 2 && failure === "session") throw Error("revoked");
};
const evidence = { kind: "response" as const, raw: {} };
const dispatch = () =>
  dispatchOrganizationScheduleConfiguration(identity, claim, "configure", session, evidence);
beforeEach(() => {
  calls.length = 0;
  failure = "";
  sessions = 0;
  storedDigest = scheduleEffectRequestDigest(request);
  update.mockClear();
  stage.mockClear();
  record.mockClear();
  preview.mockClear();
  publish.mockClear();
});
test("preparation requires fresh complete observations before staging immutable request", async () => {
  await prepareObservedOrganizationScheduleConfiguration(
    identity,
    claim,
    "create",
    session,
    evidence,
  );
  expect(calls).toEqual([
    "session",
    "read-create",
    "binding",
    "catalog",
    "customer",
    "subscription",
    "schedule",
    "map",
    "preview",
    "binding",
    "session",
    "binding",
    "stage",
  ]);
  expect(stage.mock.calls).toEqual([[identity, claim, request]]);
  expect(preview.mock.calls).toEqual([
    [
      {
        customer: "cus_original",
        schedule: "sub_sched_owned",
        preview_mode: "recurring",
        schedule_details: request.params,
      },
      { apiVersion: "2024-11-20.acacia" },
    ],
  ]);
  expect(update).not.toHaveBeenCalled();
});
test("dispatch reobserves then sends exact immutable Acacia request after marker", async () => {
  const result = await dispatch();
  expect(calls.indexOf("preview")).toBeLessThan(calls.indexOf("mark"));
  expect(calls.indexOf("mark")).toBeLessThan(calls.indexOf("update"));
  expect(update.mock.calls).toEqual([
    [
      "sub_sched_owned",
      request.params,
      { apiVersion: "2024-11-20.acacia", idempotencyKey: "configure-key", maxNetworkRetries: 0 },
    ],
  ]);
  expect(record.mock.calls).toEqual([
    [identity, claim, "configure", { kind: "response", raw: updated }],
  ]);
  expect(result.evidence.raw).toBe(updated);
  expect(publish.mock.calls).toEqual([
    [identity, claim, { create: evidence, configuration: { kind: "response", raw: updated } }],
  ]);
  expect(calls.indexOf("record")).toBeLessThan(calls.indexOf("publish"));
  expect(result.resolution.command.status).toBe("APPLIED");
});
test("changed mapping or recurring estimate cannot reach provider update", async () => {
  for (const step of ["map", "review"]) {
    failure = step;
    sessions = 0;
    await expect(dispatch()).rejects.toThrow();
    expect(calls).not.toContain("mark");
    expect(update).not.toHaveBeenCalled();
  }
});
test("changed durable request rejects dispatch before marker", async () => {
  storedDigest = "a".repeat(64);
  await expect(dispatch()).rejects.toThrow();
  expect(calls).not.toContain("mark");
  expect(update).not.toHaveBeenCalled();
});
test("revocation after provider reads and lost lease before write block update", async () => {
  for (const step of ["session", "mark"]) {
    failure = step;
    sessions = 0;
    await expect(dispatch()).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  }
});
test("unknown update retains one attempted write without replacement receipt", async () => {
  failure = "update";
  await expect(dispatch()).rejects.toThrow("lost update response");
  expect(update).toHaveBeenCalledTimes(1);
  expect(record).not.toHaveBeenCalled();
});

test("publication failure preserves one configuration attempt and original receipt", async () => {
  failure = "publish";
  await expect(dispatch()).rejects.toThrow("publication unavailable");
  expect(update).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
});
