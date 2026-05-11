/**
 * Shell access prober.
 *
 * Shell execution is app-internal — there's no OS permission for spawning
 * child processes. We honor an in-app toggle (managed by the existing
 * `PermissionManager.setShellEnabled` in
 * `packages/app-core/platforms/electrobun/src/native/permissions.ts`).
 *
 * For now, default to `granted` on all platforms. The registry can swap
 * this with a richer prober that consults the runtime config flag.
 *
 * INTEGRATION TODO: when the registry-side wiring lands, expose a hook so
 * this prober can read the user-toggled `shellEnabled` flag without
 * importing the Electrobun module (which is a one-way dependency from
 * agent → app-core that the registry agent should mediate).
 */

import type { PermissionState, Prober } from "../contracts.js";
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
