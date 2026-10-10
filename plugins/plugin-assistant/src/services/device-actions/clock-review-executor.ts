import {
  type ClockOperation,
  type ClockResult,
  validateClockOperation,
  validateClockResult,
} from "./clock-contract.ts";

export type {
  ClockAlarmContext,
  ClockAlarmOperation,
  ClockAlarmRecord,
  ClockAlarmResult,
  ClockOperation,
  ClockResult,
} from "./clock-contract.ts";
export {
  assertClockObservation,
  CLOCK_ALARM_SCHEDULE_STATES,
  CLOCK_ALARMS_CAPABILITY,
  CLOCK_CAPABILITY,
  CLOCK_REPEAT_CAPABILITY,
  clockCapabilityAvailable,
  clockTimeZone,
  validateClockAlarmContext,
  validateClockOperation,
  validateClockResult,
} from "./clock-contract.ts";
export interface ClockJournalIdentity {
  scope: string;
  proposalId: string;
}
export type ClockReviewIdentity = ClockJournalIdentity & {
  operationId: string;
};
export interface ClockReviewReply {
  result?: ClockResult;
  reviewToken?: string;
}
/** The host owns approved-entry validation, durable one-use consent, native UI and dispatch.
 * Cancellation must settle outstanding review calls. Neither this interface nor a model
 * parameter authorizes an effect: the native adapter must compare the approved journal. */
export interface ClockReviewBridge {
  reviewClock(
    input: ClockReviewIdentity & { operation: ClockOperation },
  ): Promise<ClockReviewReply>;
  confirmClock(
    input: ClockReviewIdentity & { reviewToken: string },
  ): Promise<ClockReviewReply>;
  cancelClock(input: ClockReviewIdentity): Promise<unknown>;
}
function validateResult(
  operation: ClockOperation,
  result: ClockResult,
  operationId: string,
): ClockResult {
  return validateClockResult(
    operation,
    result,
    !["unavailable", "denied", "failed", "unknown"].includes(result.status)
      ? "applied"
      : result.status === "unknown"
        ? "unknown"
        : "failed",
    operationId,
  );
}
/** Create once per mobile host/session owner, and await retire before changing owners.
 * This is renderer-safe policy, not a native journal or a platform Clock implementation. */
export function createClockReviewExecutor(bridge: ClockReviewBridge) {
  const active = new Set<() => Promise<void>>();
  /** Connection retirement waits for native cancellation before another owner activates. */
  async function retire(): Promise<void> {
    const results = await Promise.allSettled(
      [...active].map((cancel) => cancel()),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  async function review(
    operation: ClockOperation,
    operationId: string,
    identity: ClockJournalIdentity,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<ClockResult> {
    const approved = validateClockOperation(operation);
    if (
      !/^[a-f0-9]{64}$/.test(identity.scope) ||
      !/^[-A-Za-z0-9_]{1,128}$/.test(identity.proposalId) ||
      !/^[-A-Za-z0-9_]{1,128}$/.test(operationId)
    )
      throw Error("Invalid Clock journal identity");
    const input = {
      scope: identity.scope,
      proposalId: identity.proposalId,
      operationId,
    };
    let cancellation: Promise<void> | undefined;
    let cancellationFailed = false;
    let retired = false;
    const retryCancellation = () => cancel(true);
    const cancel = (retry = false) => {
      retired = true;
      if (cancellation && (!cancellationFailed || !retry)) return cancellation;
      cancellationFailed = false;
      cancellation = bridge.cancelClock(input).then(
        () => {
          active.delete(retryCancellation);
        },
        (error) => {
          cancellationFailed = true;
          throw error;
        },
      );
      return cancellation;
    };
    const current = () => {
      signal.throwIfAborted();
      if (retired) throw Error("Clock review retired");
      assertCurrent();
    };
    const onAbort = () => {
      void cancel().catch(() => {});
    };
    active.add(retryCancellation);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      current();
      const reviewed = await bridge.reviewClock({
        ...input,
        operation: approved,
      });
      current();
      if (reviewed.result)
        return validateResult(approved, reviewed.result, operationId);
      if (
        typeof reviewed.reviewToken !== "string" ||
        !reviewed.reviewToken ||
        reviewed.reviewToken.length > 128
      )
        throw Error("Clock review unavailable");
      // The native gesture is necessary but not sufficient: retain the exact live owner.
      current();
      const confirmed = await bridge.confirmClock({
        ...input,
        reviewToken: reviewed.reviewToken,
      });
      if (!confirmed.result) throw Error("Clock outcome unavailable");
      return validateResult(approved, confirmed.result, operationId);
    } finally {
      signal.removeEventListener("abort", onAbort);
      // A failed acknowledgement remains registered. Only explicit retirement can
      // retry cancellation; no failed cleanup is permission to activate another owner.
      await cancel();
    }
  }

  return { review, retire };
}
