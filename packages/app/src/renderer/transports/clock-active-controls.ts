import { CLOCK_ALARMS_CAPABILITY } from "@elizaos/plugin-assistant/device-clock-review";
import type { ClockHost } from "@elizaos/ui";

/** Agent Stop/Snooze are current-occurrence controls, not new scheduling
 * consent. The native review boundary authenticates and fences each effect.
 * Keep this lifecycle independent of the Clock page and never replay an
 * attempted proposal after an ambiguous result. */
export function createClockActiveControls(
  host: Pick<ClockHost, "status" | "proposals" | "review">,
  onError: (error: unknown) => void,
) {
  const attempted = new Set<string>();
  const controller = new AbortController();
  let queued = false;
  let running: Promise<void> | null = null;
  const scan = async () => {
    const status = await host.status();
    if (
      controller.signal.aborted ||
      !status.supported ||
      !status.scope ||
      !status.capabilities.includes(CLOCK_ALARMS_CAPABILITY)
    )
      return;
    const batch = await host.proposals();
    if (batch.scope !== status.scope || controller.signal.aborted) return;
    for (const proposal of batch.proposals) {
      const operation = proposal.operation;
      const expiresAt = Date.parse(proposal.expiresAt);
      if (
        controller.signal.aborted ||
        proposal.state !== "pending" ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now() ||
        operation.type !== "clock_alarm" ||
        !["dismiss", "snooze"].includes(operation.action)
      )
        continue;
      const key = `${batch.scope}:${proposal.id}:${proposal.digest}`;
      if (attempted.has(key)) continue;
      attempted.add(key);
      try {
        await host.review(proposal, batch.scope, controller.signal);
      } catch (error) {
        // error-policy:J4 expose a failed native control without replaying an
        // effect whose durable settlement may have happened before rejection.
        if (!controller.signal.aborted) onError(error);
      }
    }
  };
  return {
    refresh(): Promise<void> {
      if (controller.signal.aborted) return Promise.resolve();
      queued = true;
      if (!running)
        running = (async () => {
          try {
            while (queued && !controller.signal.aborted) {
              queued = false;
              await scan();
            }
          } finally {
            running = null;
          }
        })();
      return running;
    },
    stop() {
      controller.abort();
      queued = false;
    },
  };
}
