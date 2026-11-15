/**
 * Shell access prober.
 *
 * Shell execution is app-internal — there's no OS permission for spawning
 * child processes.
 *
 * The default prober reports granted access because shell execution is gated
 * elsewhere by the runtime's shell router and app-internal configuration. A
 * registry-provided prober can replace this one when a host wants permission
 * status to mirror a user-toggled `shellEnabled` flag.
 */

import type { PermissionState, Prober } from "@elizaos/core";
import { buildState } from "./_bridge.js";

const ID = "shell" as const;

export const shellProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    return buildState(ID, "granted", { canRequest: false });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    // Nothing to request — shell is app-internal.
    return buildState(ID, "granted", {
      canRequest: false,
      lastRequested: Date.now(),
    });
  },
};
