import { createDeviceActionExecution } from "@elizaos/contracts/device-action-execution";
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
  ClockDay,
  ClockHandoffOperation,
  ClockHandoffResult,
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
export type {
  ClockHandoffForm,
  ClockHandoffHostSupport,
  ClockHandoffRequest,
  ClockHandoffSetRequest,
} from "./clock-handoff.ts";
export {
  assertClockHandoffObservation,
  assertClockHandoffTimeZone,
  buildClockHandoffRequest,
  CLOCK_DAY_NAMES,
  clockHandoffCapabilities,
  clockHandoffFormDays,
  clockHandoffReceipt,
  currentClockTimeZone,
  describeClockDays,
  describeClockHandoff,
  isClockHandoffOperation,
  normalizeClockTimeZone,
  validateClockHandoffDispatch,
  validateClockHandoffResult,
} from "./clock-handoff.ts";
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
    const execution = createDeviceActionExecution(
      { ...identity, operationId },
      signal,
      assertCurrent,
    );
    const input = execution.identity;
    let cancellation: Promise<void> | undefined;
    let cancellationFailed = false;
    const retryCancellation = () => cancel(true);
    const cancel = (retry = false) => {
      execution.retire();
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
    const current = execution.assertPrepared;
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
      execution.markDispatched(input);
      const confirmed = await bridge.confirmClock({
        ...input,
        reviewToken: reviewed.reviewToken,
      });
      if (!confirmed.result) throw Error("Clock outcome unavailable");
      const result = validateResult(approved, confirmed.result, operationId);
      execution.settle(input);
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
      // A failed acknowledgement remains registered. Only explicit retirement can
      // retry cancellation; no failed cleanup is permission to activate another owner.
      await cancel();
    }
  }

  return { review, retire };
}
