/**
 * Fail-closed coverage for the auto-top-up TRIGGER gate (#13415 cloud-shared
 * service-layer fallback-slop sweep).
 *
 * `checkAndTriggerAutoTopUp` decides whether to dispatch `executeAutoTopUp` — a
 * REAL card charge — after every credit deduction. `auto_top_up_threshold` is a
 * Drizzle `numeric` column, so it arrives at the row boundary as a `string`
 * (or `null` when never configured). The gate used to coerce it with a bare
 * `Number(org.auto_top_up_threshold || 0)`.
 *
 * That silently fails OPEN on a corrupt row: a `numeric` can legitimately hold
 * `'NaN'::numeric`, which reads back as the string `"NaN"`, and `Number("NaN")`
 * is `NaN`. Because `newBalance >= NaN` is `false`, the early-return never
 * fires, so the auto-top-up charge is dispatched UNCONDITIONALLY regardless of
 * the org's actual balance.
 *
 * These tests assert the gate now fails CLOSED (skips the charge) on a corrupt
 * threshold, while the healthy paths — well-formed threshold, null threshold
 * defaulting to $0, balance-above-threshold, balance-below-threshold — are
 * unchanged.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { organizationsRepository } from "../../../db/repositories";
import type { Organization } from "../../../db/schemas/organizations";
import { autoTopUpService } from "../auto-top-up";
import { creditsService } from "../credits";

const ORG_ID = "00000000-0000-0000-0000-0000000000a7";

function orgRow(overrides: Partial<Organization>): Organization {
  // Only the auto-top-up fields are exercised by the code under test; cast a
  // minimal row to the schema type.
  return {
    id: ORG_ID,
    auto_top_up_enabled: true,
    auto_top_up_threshold: "10",
    ...overrides,
  } as unknown as Organization;
}

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()?.mockRestore();
});

// The gate is private; drive it directly. Returns void (best-effort trigger).
function triggerGate(newBalance: number): Promise<void> {
  return (
    creditsService as unknown as {
      checkAndTriggerAutoTopUp(orgId: string, newBalance: number): Promise<void>;
    }
  ).checkAndTriggerAutoTopUp(ORG_ID, newBalance);
}

describe("CreditsService.checkAndTriggerAutoTopUp threshold fail-closed", () => {
  test("corrupt 'NaN' threshold SKIPS the charge (does NOT fail open)", async () => {
    const find = spyOn(organizationsRepository, "findById").mockResolvedValue(
      orgRow({ auto_top_up_threshold: "NaN" }),
    );
    const exec = spyOn(autoTopUpService, "executeAutoTopUp").mockResolvedValue({} as never);
    spies.push(find, exec);

    // Balance is above the corrupt string's numeric value in NO meaningful
    // sense; the old code fired the charge because `1000 >= NaN` is false.
    await triggerGate(1000);

    expect(exec).not.toHaveBeenCalled();
  });

  test("corrupt non-numeric threshold SKIPS the charge", async () => {
    const find = spyOn(organizationsRepository, "findById").mockResolvedValue(
      orgRow({ auto_top_up_threshold: "not-a-number" }),
    );
    const exec = spyOn(autoTopUpService, "executeAutoTopUp").mockResolvedValue({} as never);
    spies.push(find, exec);

    await triggerGate(1000);

    expect(exec).not.toHaveBeenCalled();
  });

  test.each(["", "   "])("blank corrupt threshold SKIPS the charge: %p", async (threshold) => {
    const find = spyOn(organizationsRepository, "findById").mockResolvedValue(
      orgRow({ auto_top_up_threshold: threshold }),
    );
    const exec = spyOn(autoTopUpService, "executeAutoTopUp").mockResolvedValue({} as never);
    spies.push(find, exec);

    await triggerGate(1000);

    expect(exec).not.toHaveBeenCalled();
  });

  test("partially numeric corrupt threshold SKIPS the charge", async () => {
    const find = spyOn(organizationsRepository, "findById").mockResolvedValue(
      orgRow({ auto_top_up_threshold: "25abc" }),
    );
    const exec = spyOn(autoTopUpService, "executeAutoTopUp").mockResolvedValue({} as never);
    spies.push(find, exec);

    await triggerGate(10);

    expect(exec).not.toHaveBeenCalled();
  });

  test("balance BELOW a well-formed threshold still fires the charge (unchanged)", async () => {
    const find = spyOn(organizationsRepository, "findById").mockResolvedValue(
      orgRow({ auto_top_up_threshold: "25" }),
    );
    const exec = spyOn(autoTopUpService, "executeAutoTopUp").mockResolvedValue({} as never);
    spies.push(find, exec);

    await triggerGate(10);

    expect(exec).toHaveBeenCalledTimes(1);
  });

  test("balance AT/ABOVE a well-formed threshold does NOT fire (unchanged)", async () => {
    const find = spyOn(organizationsRepository, "findById").mockResolvedValue(
      orgRow({ auto_top_up_threshold: "25" }),
    );
    const exec = spyOn(autoTopUpService, "executeAutoTopUp").mockResolvedValue({} as never);
    spies.push(find, exec);

    await triggerGate(25);

    expect(exec).not.toHaveBeenCalled();
  });

  test("null threshold defaults to $0 (only fires below zero) — preserves `|| 0`", async () => {
    const find = spyOn(organizationsRepository, "findById").mockResolvedValue(
      orgRow({ auto_top_up_threshold: null as unknown as string }),
    );
    const exec = spyOn(autoTopUpService, "executeAutoTopUp").mockResolvedValue({} as never);
    spies.push(find, exec);

    // Above zero: no charge.
    await triggerGate(5);
    expect(exec).not.toHaveBeenCalled();

    // Below zero (overdrawn): default-0 threshold fires.
    await triggerGate(-1);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  test("auto-top-up disabled SKIPS the charge regardless of threshold", async () => {
    const find = spyOn(organizationsRepository, "findById").mockResolvedValue(
      orgRow({ auto_top_up_enabled: false, auto_top_up_threshold: "25" }),
    );
    const exec = spyOn(autoTopUpService, "executeAutoTopUp").mockResolvedValue({} as never);
    spies.push(find, exec);

    await triggerGate(1);

    expect(exec).not.toHaveBeenCalled();
  });

  test("missing org SKIPS the charge", async () => {
    const find = spyOn(organizationsRepository, "findById").mockResolvedValue(undefined);
    const exec = spyOn(autoTopUpService, "executeAutoTopUp").mockResolvedValue({} as never);
    spies.push(find, exec);

    await triggerGate(1);

    expect(exec).not.toHaveBeenCalled();
  });
});
