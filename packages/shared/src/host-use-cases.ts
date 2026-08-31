/**
 * Transport-neutral host controller primitives shared by the standalone agent
 * and app-core. HTTP authorization, response shaping, runtime lookup, and
 * persistence remain host-owned trust-boundary concerns.
 */

export interface DueTaskRunner {
  runDueTasks(): Promise<void>;
}

/**
 * Coalesces overlapping host wake requests onto one pass per TaskService
 * instance. Each host owns a coordinator, while runtime replacement remains an
 * independent scheduling boundary inside that host.
 */
export class BackgroundTaskRunCoordinator {
  private readonly inFlight = new WeakMap<DueTaskRunner, Promise<void>>();

  async run(service: DueTaskRunner): Promise<{ coalesced: boolean }> {
    const existing = this.inFlight.get(service);
    if (existing !== undefined) {
      await existing;
      return { coalesced: true };
    }

    const current = service.runDueTasks();
    this.inFlight.set(service, current);
    try {
      await current;
      return { coalesced: false };
    } finally {
      if (this.inFlight.get(service) === current) {
        this.inFlight.delete(service);
      }
    }
  }
}

/** Canonical formatting-insensitive representation of a device pairing code. */
export function normalizeHostPairingCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}
