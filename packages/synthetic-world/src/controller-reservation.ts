/**
 * Keeps process-local controller ownership fail-closed until production
 * runtime cleanup has definitely completed.
 */

import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core/errors";
import type { SyntheticEnvironmentLeaseAuthority } from "@elizaos/shared/contracts/synthetic-environment-lease";

const activeControllers = new Map<string, string>();

function reservationKey(authority: SyntheticEnvironmentLeaseAuthority): string {
  return `${authority.namespace}\u0000${authority.generation}`;
}

/** Internal reservation shared by boot and teardown composition. */
export class ActiveSyntheticControllerReservation {
  static acquire(
    authority: SyntheticEnvironmentLeaseAuthority,
  ): ActiveSyntheticControllerReservation {
    const key = reservationKey(authority);
    if (activeControllers.has(key)) {
      throw new ElizaError(
        "A controller already owns this namespace generation",
        {
          code: "SYNTHETIC_CONTROLLER_COLLISION",
          severity: "fatal",
          context: {
            namespace: authority.namespace,
            generation: authority.generation,
          },
        },
      );
    }
    const token = randomUUID();
    activeControllers.set(key, token);
    return new ActiveSyntheticControllerReservation(key, token);
  }

  private constructor(
    private readonly key: string,
    private readonly token: string,
  ) {}

  async releaseAfterConfirmedCleanup(
    cleanup: () => Promise<void>,
  ): Promise<void> {
    await cleanup();
    this.release();
  }

  releaseWithoutRuntime(): void {
    this.release();
  }

  private release(): void {
    if (activeControllers.get(this.key) !== this.token) {
      throw new ElizaError("Controller reservation ownership was lost", {
        code: "SYNTHETIC_CONTROLLER_RESERVATION_LOST",
        severity: "fatal",
      });
    }
    activeControllers.delete(this.key);
  }
}
