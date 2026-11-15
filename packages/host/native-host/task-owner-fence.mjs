// @ts-check
/**
 * The task gateway's owner fence as a pure step. One account owns tasks at a
 * time; each account change starts a new epoch, and a request answers only
 * for the epoch it authenticated in. The gateway applies `revoke` and owns
 * the awaits; this module owns every decision.
 *
 * @typedef {{ epoch: number, owner: string | null, settled: number, closed: boolean }} OwnerFence
 * @typedef {{ type: "read", sequence: number, startedEpoch: number, account: string | null, confirming: boolean }
 *   | { type: "revoke" }
 *   | { type: "close" }} OwnerFenceEvent
 * @typedef {"superseded" | "confirm" | "accepted" | "signed-out"} OwnerFenceDecision
 */

/** @type {OwnerFence} */
export const initialOwnerFence = Object.freeze({
  epoch: 0,
  owner: null,
  settled: 0,
  closed: false,
});

/**
 * One gate read, or a host revoke or close. A read whose `account` is null
 * means the gate failed or named no account.
 *
 * A read that would revoke the live owner's tasks answers "confirm" first:
 * the gateway reads the gate again and passes that read with `confirming`.
 * A credential write in progress can fail one read, and reads can return out
 * of order, so a single read never ends the signed-in person's own task.
 *
 * @param {OwnerFence} fence
 * @param {OwnerFenceEvent} event
 * @returns {{ fence: OwnerFence, decision: OwnerFenceDecision, revoke: boolean }}
 */
export function ownerFenceStep(fence, event) {
  if (event.type !== "read")
    return {
      fence: {
        ...fence,
        epoch: fence.epoch + 1,
        owner: null,
        closed: fence.closed || event.type === "close",
      },
      decision: "signed-out",
      revoke: true,
    };
  const { account, sequence } = event;
  // A late gate result must not change ownership or revoke a newer task.
  if (
    fence.closed ||
    event.startedEpoch !== fence.epoch ||
    (sequence < fence.settled && (!account || account !== fence.owner))
  )
    return { fence, decision: "superseded", revoke: false };
  const revokes = fence.owner !== null && account !== fence.owner;
  if (revokes && !event.confirming)
    return { fence, decision: "confirm", revoke: false };
  const settled = Math.max(fence.settled, sequence);
  if (!account)
    return {
      fence: { ...fence, epoch: fence.epoch + 1, owner: null, settled },
      decision: "signed-out",
      revoke: true,
    };
  return {
    fence: {
      ...fence,
      epoch: revokes ? fence.epoch + 1 : fence.epoch,
      owner: account,
      settled,
    },
    decision: "accepted",
    revoke: revokes,
  };
}
