import { beforeEach, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

const calls: string[] = [];
let phase: "schedule_create" | "schedule_configure" | "schedule_release" = "schedule_create";
let effectState: "ready" | "started" | "observed" = "ready";
let commandStatus = "PREPARED",
  failure = "",
  occupied = false;
const input = {
  organizationId: "org",
  actorId: "actor",
  quoteId: "quote",
  idempotencyKey: "original-key",
};
const claim = { commandId: "command", leaseToken: "lease", generation: 1 };
const effect = () => ({
  id: "effect",
  kind: phase,
  state: effectState,
  started_at: new Date(1000),
  request_payload: { kind: "schedule_create", subscriptionId: "sub_original" },
  provider_idempotency_key: "original-key",
  customer_id: "cus_original",
  subscription_id: "sub_original",
  livemode: false,
});
const command = () => ({
  id: "command",
  subscription_id: "subscription",
  target_plan_key: "plus_monthly",
  expected_subscription_revision: 1,
  result_subscription_revision: commandStatus === "APPLIED" ? 2 : null,
  status: commandStatus,
  organization_schedule_configuration_evidence: commandStatus === "APPLIED" ? {} : null,
  organization_schedule_failure_evidence: commandStatus === "FAILED" ? {} : null,
  provider_response_digest: "private",
  request_payload: "private",
});
const repoPath = resolve(import.meta.dir, "../../db/repositories");
mock.module(resolve(repoPath, "organization-downgrade-commands.ts"), () => ({
  prepareOrganizationDowngrade: async () => {
    calls.push("prepare");
    return { command: command(), created: commandStatus === "PREPARED" };
  },
}));
mock.module(resolve(repoPath, "organization-schedule-effects.ts"), () => ({
  claimOrganizationSchedule: async () => {
    calls.push("claim");
    if (occupied) return null;
    commandStatus = "OUTCOME_UNKNOWN";
    return { claim, effect: effect(), canDispatch: true };
  },
  finishOrganizationScheduleAttempt: async () => {
    calls.push("finish");
    if (failure === "finish") throw Error("database unavailable");
  },
  readOrganizationScheduleCommand: async () => {
    calls.push("status");
    return { command: command(), effects: [effect()] };
  },
  readOrganizationScheduleRecoverySource: async () => {
    calls.push("recovery_source");
    return { effects: [effect()], apiVersion: "2024-11-20.acacia" };
  },
  recordAuthenticatedOrganizationScheduleEvidence: async () => {
    calls.push("receipt");
    effectState = "observed";
  },
}));
mock.module(resolve(import.meta.dir, "organization-schedule-dispatch.ts"), () => ({
  dispatchOrganizationScheduleCreate: async (
    _identity: unknown,
    _claim: unknown,
    _effect: unknown,
    verify: () => Promise<void>,
  ) => {
    await verify();
    calls.push("create");
    effectState = "started";
    if (failure === "create") throw Error("lost response");
    effectState = "observed";
    return { evidence: { kind: "response", raw: { private: true } } };
  },
}));
mock.module(resolve(import.meta.dir, "organization-schedule-configuration.ts"), () => ({
  prepareObservedOrganizationScheduleConfiguration: async (
    _identity: unknown,
    _claim: unknown,
    _effect: unknown,
    verify: () => Promise<void>,
  ) => {
    await verify();
    calls.push("prepare_configuration");
    phase = "schedule_configure";
    effectState = "ready";
    return { id: "configuration" };
  },
  dispatchOrganizationScheduleConfiguration: async (
    _identity: unknown,
    _claim: unknown,
    _effect: unknown,
    verify: () => Promise<void>,
  ) => {
    await verify();
    calls.push("configure");
    effectState = "started";
    if (failure === "configure") throw Error("lost configure response");
    effectState = "observed";
    commandStatus = "APPLIED";
  },
}));
mock.module(resolve(import.meta.dir, "organization-schedule-publication.ts"), () => ({
  observeAndFinalizeOrganizationScheduleConfiguration: async () => {
    calls.push("recover_configuration");
    commandStatus = "APPLIED";
    effectState = "observed";
  },
}));
mock.module(resolve(import.meta.dir, "organization-schedule-compensation.ts"), () => ({
  compensateOrganizationScheduleCreate: async () => {
    calls.push("compensate");
    if (phase !== "schedule_create" || effectState !== "observed")
      throw Error("Uncertain effect cannot compensate");
    phase = "schedule_release";
    effectState = "observed";
    commandStatus = "FAILED";
  },
  recoverOrganizationScheduleCompensation: async () => {
    calls.push("recover_release");
    commandStatus = "FAILED";
    effectState = "observed";
  },
}));
mock.module(resolve(import.meta.dir, "organization-schedule-event-search.ts"), () => ({
  findOriginalScheduleEvent: async () => {
    calls.push("find_event");
    if (failure === "event") throw Error("Original evidence unavailable");
    return { raw: { private: true } };
  },
}));
mock.module(resolve(import.meta.dir, "../stripe.ts"), () => ({
  requireStripe: () => ({ events: {} }),
}));
const {
  confirmOrganizationSubscriptionDowngrade: confirm,
  readOrganizationSubscriptionDowngrade: read,
} = await import("./organization-downgrade-command");
const verify = async () => {
  calls.push("session");
};
beforeEach(() => {
  calls.length = 0;
  phase = "schedule_create";
  effectState = "ready";
  commandStatus = "PREPARED";
  failure = "";
  occupied = false;
});
test("original confirmation creates, configures and returns only durable public status", async () => {
  const result = await confirm(input, verify);
  expect(result.status).toBe("APPLIED");
  expect(calls.filter((c) => ["create", "configure", "finish"].includes(c))).toEqual([
    "create",
    "configure",
    "finish",
  ]);
  expect(JSON.stringify(result)).not.toContain("private");
  calls.length = 0;
  expect((await confirm(input, verify)).commandId).toBe(result.commandId);
  expect(calls).toEqual(["session", "prepare", "status", "session"]);
});
test("lost create recovers original evidence before configuration without another create", async () => {
  failure = "create";
  expect((await confirm(input, verify)).status).toBe("OUTCOME_UNKNOWN");
  failure = "";
  calls.length = 0;
  expect((await confirm(input, verify)).status).toBe("APPLIED");
  expect(calls).not.toContain("create");
  expect(calls.indexOf("receipt")).toBeLessThan(calls.indexOf("prepare_configuration"));
});
test("unavailable original creation remains unknown and never configures", async () => {
  effectState = "started";
  commandStatus = "OUTCOME_UNKNOWN";
  failure = "event";
  expect((await confirm(input, verify)).status).toBe("OUTCOME_UNKNOWN");
  expect(calls).not.toContain("create");
  expect(calls).not.toContain("configure");
  expect(calls).toContain("finish");
});
test("lost configuration recovers read-only without another update", async () => {
  failure = "configure";
  expect((await confirm(input, verify)).status).toBe("OUTCOME_UNKNOWN");
  calls.length = 0;
  expect((await confirm(input, verify)).status).toBe("APPLIED");
  expect(calls).toContain("recover_configuration");
  expect(calls).not.toContain("configure");
  expect(calls).not.toContain("create");
});
test("started cleanup only recovers original release", async () => {
  phase = "schedule_release";
  effectState = "started";
  commandStatus = "OUTCOME_UNKNOWN";
  expect((await confirm(input, verify)).failure).toBe("create_compensated");
  expect(calls).toContain("recover_release");
  expect(calls).not.toContain("compensate");
});
test("occupied lease returns status without provider work", async () => {
  occupied = true;
  commandStatus = "OUTCOME_UNKNOWN";
  expect((await confirm(input, verify)).status).toBe("OUTCOME_UNKNOWN");
  expect(calls).toEqual(["session", "prepare", "claim", "status", "session"]);
});
test("session failure after creation is preserved after eligible cleanup and lease release", async () => {
  let n = 0;
  await expect(
    confirm(input, async () => {
      if (++n === 3) throw Error("session revoked");
    }),
  ).rejects.toThrow("session revoked");
  expect(calls).toContain("compensate");
  expect(calls).toContain("finish");
  expect(calls).not.toContain("configure");
});
test("status read performs no provider work", async () => {
  await read({ organizationId: "org", actorId: "actor", commandId: "command" }, verify);
  expect(calls).toEqual(["status", "session"]);
});

test("session failure remains the response even if lease cleanup is unavailable", async () => {
  failure = "finish";
  let n = 0;
  await expect(
    confirm(input, async () => {
      if (++n === 3) throw Error("session revoked");
    }),
  ).rejects.toThrow("session revoked");
  expect(calls).toContain("finish");
});
test("lease cleanup failure is a typed unavailable outcome", async () => {
  failure = "finish";
  await expect(confirm(input, verify)).rejects.toMatchObject({
    code: "SUBSCRIPTION_DOWNGRADE_STATUS_UNAVAILABLE",
  });
});
