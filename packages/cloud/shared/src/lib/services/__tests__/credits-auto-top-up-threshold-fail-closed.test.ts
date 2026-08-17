/**
 * The post-debit nudge must delegate to the durable service. Eligibility is
 * deliberately not reimplemented from a stale balance/organization snapshot;
 * claimEligibleAttempt rechecks it under the organization write lock.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { runWithRequestContext } from "../../runtime/request-context";
import { logger } from "../../utils/logger";
import { autoTopUpService } from "../auto-top-up";
import {
  type PostDebitNotificationOperations,
  runObservedPostDebitNotifications,
  triggerDurableAutoTopUpForBalanceDecrease,
} from "../credits";

const ORG_ID = "00000000-0000-0000-0000-0000000000a7";
const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  while (spies.length) spies.pop()?.mockRestore();
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function notificationOperations(nudge: Promise<void>): PostDebitNotificationOperations {
  return {
    checkAutoTopUp: () => nudge,
    queueLowCreditsEmail: () => Promise.resolve(undefined),
    notifyWaifuCredits: () => Promise.resolve(undefined),
  };
}

describe("CreditsService durable auto-top-up nudge", () => {
  test("passes only the tenant id and credit-deduction source to the durable service", async () => {
    const execute = spyOn(autoTopUpService, "executeAutoTopUpForOrganization").mockResolvedValue({
      organizationId: ORG_ID,
      success: false,
      status: "not_needed",
      recovered: false,
    });
    spies.push(execute);

    await triggerDurableAutoTopUpForBalanceDecrease(ORG_ID);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(ORG_ID, { source: "credit_deduction" });
  });

  test("propagates a nudge failure so the notification aggregate can observe it", async () => {
    const failure = new Error("primary database unavailable");
    const execute = spyOn(autoTopUpService, "executeAutoTopUpForOrganization").mockRejectedValue(
      failure,
    );
    spies.push(execute);

    await expect(triggerDurableAutoTopUpForBalanceDecrease(ORG_ID)).rejects.toBe(failure);
  });

  test("registers the exact observed notification aggregate with request-scoped defer", async () => {
    const nudge = deferred<void>();
    const captured: Promise<unknown>[] = [];

    await runWithRequestContext(
      {
        defer: (task) => captured.push(task),
      },
      () => runObservedPostDebitNotifications(notificationOperations(nudge.promise)),
    );

    expect(captured).toHaveLength(1);
    let completed = false;
    void captured[0]?.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    nudge.resolve(undefined);
    await captured[0];
    expect(completed).toBe(true);
  });

  test("awaits the same notification work when no runtime defer is present", async () => {
    const nudge = deferred<void>();
    let returned = false;

    const completion = runObservedPostDebitNotifications(
      notificationOperations(nudge.promise),
    ).then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);

    nudge.resolve(undefined);
    await completion;
    expect(returned).toBe(true);
  });

  test("observes a deferred nudge rejection before the aggregate settles", async () => {
    const nudge = deferred<void>();
    const captured: Promise<unknown>[] = [];
    const log = spyOn(logger, "error").mockImplementation(() => undefined);
    spies.push(log);

    await runWithRequestContext({ defer: (task) => captured.push(task) }, () =>
      runObservedPostDebitNotifications(notificationOperations(nudge.promise)),
    );
    nudge.reject(new Error("primary unavailable"));
    await captured[0];

    expect(log).toHaveBeenCalledWith(
      "[CreditsService] Failed to check auto top-up:",
      expect.objectContaining({ message: "primary unavailable" }),
    );
  });
});
