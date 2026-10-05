import { beforeEach, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

const identity = { organizationId: "org", actorId: "original-actor", commandId: "command" };
const claim = { commandId: "command", leaseToken: "original-lease", generation: 3 };
const calls: string[] = [];
let kind = "schedule_configure",
  state = "started",
  status = "OUTCOME_UNKNOWN";
let expired = true,
  occupied = false,
  failRecord = false;
let failingCommand = "";
let due = [{ id: "command", organization_id: "org", requested_by_user_id: "original-actor" }];
const outcomes: unknown[] = [];
const repos = resolve(import.meta.dir, "../../db/repositories");
mock.module(resolve(repos, "organization-schedule-effects.ts"), () => ({
  claimOrganizationSchedule: async (input: typeof identity, mode: string) => {
    expect(mode).toBe("recovery");
    expect(input.actorId).toBe("original-actor");
    calls.push(`claim:${input.commandId}`);
    if (input.commandId === failingCommand) throw Error("private provider payload");
    return occupied ? null : { claim, effect: { kind, state } };
  },
  finishOrganizationScheduleAttempt: async (input: typeof identity, original: unknown) => {
    expect(input.actorId).toBe("original-actor");
    expect(original).toBe(claim);
    calls.push("finish");
  },
  readOrganizationScheduleRecoveryCommand: async () => ({ status }),
  readOrganizationScheduleRecoverySource: async () => ({
    reviewExpiresAt: new Date(expired ? 0 : 2000),
    observedAt: new Date(1000),
  }),
}));
mock.module(resolve(repos, "organization-schedule-maintenance.ts"), () => ({
  listOrganizationScheduleRecovery: async (limit: number) => {
    expect(limit).toBe(5);
    return due;
  },
  recordOrganizationScheduleRecoveryOutcome: async (input: unknown) => {
    outcomes.push(input);
    if (failRecord) throw Error("incident journal unavailable");
  },
}));
mock.module(resolve(import.meta.dir, "organization-schedule-create-recovery.ts"), () => ({
  recoverOriginalOrganizationScheduleCreate: async () => {
    calls.push("observe_create");
    return { kind: "event", raw: { id: "original-event" } };
  },
}));
mock.module(resolve(import.meta.dir, "organization-schedule-publication.ts"), () => ({
  observeAndFinalizeOrganizationScheduleConfiguration: async () => {
    calls.push("observe_configure");
    status = "APPLIED";
  },
}));
mock.module(resolve(import.meta.dir, "organization-schedule-compensation.ts"), () => ({
  compensateOrganizationScheduleCreate: async () => {
    calls.push("cleanup");
    status = "FAILED";
  },
  recoverOrganizationScheduleCompensation: async () => {
    calls.push("observe_release");
    status = "FAILED";
  },
}));
// These actuators must never be reached by unattended original-command recovery.
mock.module(resolve(import.meta.dir, "organization-schedule-dispatch.ts"), () => ({
  dispatchOrganizationScheduleCreate: async () => {
    throw Error("new creation forbidden");
  },
}));
mock.module(resolve(import.meta.dir, "organization-schedule-configuration.ts"), () => ({
  dispatchOrganizationScheduleConfiguration: async () => {
    throw Error("new configuration forbidden");
  },
  prepareObservedOrganizationScheduleConfiguration: async () => {
    throw Error("new configuration forbidden");
  },
}));
const { reconcileOriginalOrganizationSchedule, recoverOrganizationSchedules } = await import(
  "./organization-schedule-maintenance"
);
beforeEach(() => {
  calls.length = outcomes.length = 0;
  kind = "schedule_configure";
  state = "started";
  status = "OUTCOME_UNKNOWN";
  expired = true;
  occupied = failRecord = false;
  failingCommand = "";
  due = [{ id: "command", organization_id: "org", requested_by_user_id: "original-actor" }];
});
for (const originalState of ["started", "observed"]) {
  test(`configuration ${originalState} uses read-only publication`, async () => {
    state = originalState;
    expect(await reconcileOriginalOrganizationSchedule(identity)).toBe("APPLIED");
    expect(calls).toEqual(["claim:command", "observe_configure", "finish"]);
  });
  test(`release ${originalState} only observes original release`, async () => {
    kind = "schedule_release";
    state = originalState;
    expect(await reconcileOriginalOrganizationSchedule(identity)).toBe("FAILED");
    expect(calls).toEqual(["claim:command", "observe_release", "finish"]);
  });
  test(`creation ${originalState} cleans up only after review expires`, async () => {
    kind = "schedule_create";
    state = originalState;
    expired = false;
    expect(await reconcileOriginalOrganizationSchedule(identity)).toBe("OUTCOME_UNKNOWN");
    expect(calls).toEqual(["claim:command", "finish"]);
    calls.length = 0;
    expired = true;
    expect(await reconcileOriginalOrganizationSchedule(identity)).toBe("FAILED");
    expect(calls).toEqual(["claim:command", "observe_create", "cleanup", "finish"]);
  });
}
test("ready configuration waits for interactive confirmation or original cleanup after expiry", async () => {
  state = "ready";
  expired = false;
  expect(await reconcileOriginalOrganizationSchedule(identity)).toBe("OUTCOME_UNKNOWN");
  expect(calls).toEqual(["claim:command", "finish"]);
  expired = true;
  calls.length = 0;
  expect(await reconcileOriginalOrganizationSchedule(identity)).toBe("FAILED");
  expect(calls).toEqual(["claim:command", "observe_create", "cleanup", "finish"]);
});
test("ready release delegates only to proven partial-create cleanup", async () => {
  kind = "schedule_release";
  state = "ready";
  expect(await reconcileOriginalOrganizationSchedule(identity)).toBe("FAILED");
  expect(calls).toEqual(["claim:command", "cleanup", "finish"]);
});
test("ready creation never dispatches and finishes original attempt", async () => {
  kind = "schedule_create";
  state = "ready";
  expect(await reconcileOriginalOrganizationSchedule(identity)).toBe("OUTCOME_UNKNOWN");
  expect(calls).toEqual(["claim:command", "finish"]);
});
test("held lease defers without effects; expired prepared command reports its terminal result", async () => {
  occupied = true;
  expect(await reconcileOriginalOrganizationSchedule(identity)).toBe("deferred");
  status = "SUPERSEDED";
  expect(await reconcileOriginalOrganizationSchedule(identity)).toBe("SUPERSEDED");
  expect(calls).toEqual(["claim:command", "claim:command"]);
});
test("one unavailable original command records sanitized uncertainty and does not starve the next", async () => {
  failingCommand = "command";
  due.push({ ...due[0], id: "next-command" });
  expect(await recoverOrganizationSchedules()).toEqual({
    inspected: 2,
    applied: 1,
    failed: 0,
    pending: 0,
    unavailable: 1,
    deferred: 0,
  });
  expect(outcomes).toEqual([
    { ...identity, issueCode: "SCHEDULE_RECOVERY_UNAVAILABLE" },
    { ...identity, commandId: "next-command", issueCode: null },
  ]);
});
test("failure to retain uncertainty fails the maintenance lane", async () => {
  failingCommand = "command";
  failRecord = true;
  await expect(recoverOrganizationSchedules()).rejects.toThrow("incident journal unavailable");
});
test("pending and held commands are distinct and do not resolve incidents", async () => {
  expired = false;
  kind = "schedule_create";
  expect((await recoverOrganizationSchedules()).pending).toBe(1);
  occupied = true;
  expect((await recoverOrganizationSchedules()).deferred).toBe(1);
  expect(outcomes).toEqual([]);
});
