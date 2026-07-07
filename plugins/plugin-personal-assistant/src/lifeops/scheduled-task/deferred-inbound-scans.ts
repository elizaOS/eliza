/**
 * Detaches PA's inbound scheduled-task scans from the awaited `MESSAGE_RECEIVED`
 * edge so a slow store/DB scan cannot delay the reply's first token (#15255).
 *
 * `AgentRuntime.emitEvent` awaits `Promise.all` over every registered handler,
 * and both TTFT entry edges (`MessageService.handleMessage`, the agent API chat
 * route) await that emit before Stage-1 work. The PA completion/dismissal scans
 * registered on `MESSAGE_RECEIVED` are pure side effects that do not feed the
 * first token, so wrapping each one here makes the handler return immediately
 * and run the scan in the background. The core trajectories handler — which
 * stamps `message.metadata.trajectoryStepId` that `message.ts` reads right after
 * the emit resolves — is a different, un-wrapped handler and stays synchronous.
 *
 * A detached scan can no longer reject the emit, so its failures are surfaced
 * through `runtime.reportError` (RECENT_ERRORS provider + logs + owner
 * escalation) instead of the awaited call stack. The in-flight set is a
 * module-level singleton so `settleDeferredInboundScans` (test-only) can await
 * every scan that a `MESSAGE_RECEIVED` emit spawned before asserting store state.
 */

import type { MessagePayload } from "@elizaos/core";

const inFlight = new Set<Promise<void>>();

/**
 * Wrap a `MESSAGE_RECEIVED` scan so the awaited emit edge resolves without it.
 * The returned handler schedules `fn`, tracks it for {@link
 * settleDeferredInboundScans}, and resolves immediately; `fn` runs to
 * completion in the background and any rejection is reported via
 * `payload.runtime.reportError` under the scope `lifeops:inbound-scan:<name>`.
 */
export function detachInboundScan(
  name: string,
  fn: (payload: MessagePayload) => Promise<void>,
): (payload: MessagePayload) => Promise<void> {
  return (payload: MessagePayload): Promise<void> => {
    const scan: Promise<void> = fn(payload)
      .catch((error: unknown) => {
        // error-policy:J7 diagnostics-must-not-kill-the-loop — the turn has
        // already moved on off the awaited edge; surface the failure through
        // reportError (RECENT_ERRORS + logs) rather than dropping it.
        payload.runtime.reportError(`lifeops:inbound-scan:${name}`, error, {
          roomId: payload.message.roomId,
          messageId: payload.message.id,
        });
      })
      .finally(() => {
        inFlight.delete(scan);
      });
    inFlight.add(scan);
    return Promise.resolve();
  };
}

/**
 * Await every deferred inbound scan currently in flight. Loops because a scan
 * may schedule another detached scan while it runs. Test-only: production never
 * blocks on these side effects.
 */
export async function settleDeferredInboundScans(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.all([...inFlight]);
  }
}
