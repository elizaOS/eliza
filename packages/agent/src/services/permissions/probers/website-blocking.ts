/**
 * Website blocking prober.
 *
 * App-internal feature — implemented via hosts-file edits / VPN DNS / NE
 * content blocker depending on platform. There's no OS-level permission
 * dialog for "may this app block websites" beyond the elevation prompt
 * the website-blocker plugin issues at block time.
 *
 * For the registry's purposes we report `granted` so the plumbing exists,
 * and let the website-blocker plugin handle the elevation flow at
 * `startBlock` time. The richer status (requires elevation, hosts file
 * writable, etc.) lives in `WebsiteBlockerPluginLike.getStatus()`.
 */

import type { PermissionState, Prober } from "../contracts.js";
import { buildState } from "./_bridge.js";

const ID = "website-blocking" as const;

export const websiteBlockingProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    return buildState(ID, "granted", { canRequest: false });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    return buildState(ID, "granted", {
      canRequest: false,
      lastRequested: Date.now(),
    });
  },
};
