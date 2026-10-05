import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";

let due = [
  { id: "a", organization_id: "org" },
  { id: "b", organization_id: "org" },
];
let behavior = async (_input: { commandId: string }): Promise<unknown> => ({
  status: "pending",
  reason: "awaiting_payment",
});
const recover = mock(async (input: { commandId: string }) => behavior(input));
const record = mock(async (_input: unknown) => ({ recorded: true, resolved: 0 }));
mock.module("../../db/repositories/organization-upgrade-observation-lease", () => ({
  listOrganizationUpgradeRecovery: async () => due,
}));
mock.module("../../db/repositories/organization-upgrade-recovery-incidents", () => ({
  recordOrganizationUpgradeRecoveryOutcome: record,
}));
mock.module("./organization-upgrade-recovery", () => ({
  reconcileOriginalOrganizationUpgrade: recover,
}));
const { recoverOrganizationUpgrades: run } = await import("./organization-upgrade-maintenance");
beforeEach(() => {
  due = [
    { id: "a", organization_id: "org" },
    { id: "b", organization_id: "org" },
  ];
  behavior = async () => ({ status: "pending", reason: "awaiting_payment" });
  recover.mockClear();
  record.mockReset();
  record.mockImplementation(async () => ({ recorded: true, resolved: 0 }));
});
afterAll(() => mock.restore());
test("one unavailable command is recorded without starving the next applied command", async () => {
  behavior = async (input) => {
    if (input.commandId === "a") throw new Error("raw provider body");
    return { status: "applied" };
  };
  expect(await run()).toEqual({
    inspected: 2,
    applied: 1,
    failed: 0,
    pending: 0,
    unavailable: 1,
    deferred: 0,
  });
  expect(record.mock.calls.map((x) => x[0])).toEqual([
    { organizationId: "org", commandId: "a", issueCode: "UPGRADE_RECOVERY_UNAVAILABLE" },
    { organizationId: "org", commandId: "b", issueCode: null },
  ]);
});
test("ordinary pending payment is not fabricated as an incident", async () => {
  expect((await run()).pending).toBe(2);
  expect(record).not.toHaveBeenCalled();
});
test("unresolved invoice states receive a durable incident", async () => {
  behavior = async () => ({ status: "pending", reason: "requires_reconciliation" });
  expect((await run()).pending).toBe(2);
  expect(record).toHaveBeenCalledTimes(2);
});
test("failure to retain incident evidence fails the maintenance lane", async () => {
  behavior = async () => {
    throw new Error("provider unavailable");
  };
  record.mockImplementation(async () => {
    throw new Error("journal unavailable");
  });
  await expect(run()).rejects.toThrow("journal unavailable");
  expect(recover).toHaveBeenCalledTimes(1);
});
test("a healthy prior observation does not impose a separate deadline on the next command", async () => {
  let clock = 0;
  const timer = spyOn(performance, "now").mockImplementation(() => clock);
  behavior = async () => {
    clock = 26000;
    return { status: "pending", reason: "awaiting_payment" };
  };
  try {
    expect(await run()).toEqual({
      inspected: 2,
      applied: 0,
      failed: 0,
      pending: 2,
      unavailable: 0,
      deferred: 0,
    });
    expect(recover.mock.calls[0]).toEqual([{ organizationId: "org", commandId: "a" }]);
    expect(recover).toHaveBeenCalledTimes(2);
  } finally {
    timer.mockRestore();
  }
});

test("definitive void result closes its incident and is counted separately", async () => {
  behavior = async () => ({ status: "failed" });
  expect((await run()).failed).toBe(2);
  expect(record).toHaveBeenCalledTimes(2);
});
