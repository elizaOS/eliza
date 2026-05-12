/**
 * ChannelSimulator — feeds script steps into the agent harness on virtual time.
 *
 * For each scripted step `{ t, channel, sender, text }`:
 *   1. Wait until the virtual clock reaches `t` (via FakeClock.runUntil).
 *   2. Invoke the registered `onMessage(step)` callback. The callback hands
 *      the message to the runtime under test (Stage-1 evaluator + dispatch).
 *
 * Channel boundaries are real here: each channel has its own room queue
 * (delegated to RoomHandlerQueue) so concurrent messages on different rooms
 * run in parallel, but multiple messages on the SAME room serialize.
 */

import { RoomHandlerQueue } from "@elizaos/core";
import type { FakeClock } from "./clock.ts";
import type { Scenario, ScenarioScriptStep, TraceEvent } from "./types.ts";
import type { Trace } from "./trace.ts";

export interface ChannelDelivery {
  step: ScenarioScriptStep;
}

export type OnMessageCallback = (
  delivery: ChannelDelivery,
) => Promise<void>;

export class ChannelSimulator {
  readonly queue = new RoomHandlerQueue();
  /** Background promises that wrap RoomHandlerQueue runs. Awaited at quiesce. */
  private inflight: Promise<unknown>[] = [];

  constructor(
    private readonly clock: FakeClock,
    private readonly trace: Trace,
  ) {}

  /**
   * Schedule every step in the scenario. Returns a promise that resolves
   * when all steps have been dispatched into the room queue (not when the
   * handlers complete — call `quiesce()` for that).
   */
  schedule(scenario: Scenario, onMessage: OnMessageCallback): void {
    for (const step of scenario.script) {
      this.clock.scheduleAt(step.t, () => {
        this.trace.push("message_in", {
          channel: step.channel,
          sender: step.sender,
          text: step.text,
        });
        const p = this.queue
          .runWith(step.channel, () => onMessage({ step }))
          .catch((err) => {
            this.trace.push("error", {
              detail: {
                where: "channels.onMessage",
                error: err instanceof Error ? err.message : String(err),
              },
            });
          });
        this.inflight.push(p);
      });
    }
  }

  /** Wait for all dispatched handlers to settle. */
  async quiesce(): Promise<void> {
    // Drain the room queue first.
    await this.queue.quiesceAll();
    // Then await any background error capture.
    await Promise.all(this.inflight);
  }

  events(): readonly TraceEvent[] {
    return this.trace.all();
  }
}
