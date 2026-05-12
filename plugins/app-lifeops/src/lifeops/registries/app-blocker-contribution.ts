/**
 * App-blocker enforcer.
 *
 * Wraps the `app-blocker` engine (iOS Family Controls / Android Usage Access)
 * as a {@link BlockerContribution}. BLOCK target=app dispatches through this
 * entry instead of importing engine functions directly so a new
 * mobile-blocker backend (e.g. a desktop screen-time tie-in) is a registration
 * call.
 */

import {
  getAppBlockerStatus,
  startAppBlock,
  stopAppBlock,
} from "../../app-blocker/engine.js";
import type {
  BlockAppsOptions,
  BlockAppsResult,
} from "../../app-blocker/types.js";
import type {
  BlockerAvailability,
  BlockerContribution,
  BlockerStatusSummary,
} from "./blocker-registry.js";

export const appBlockerContribution: BlockerContribution<
  BlockAppsOptions,
  BlockAppsResult
> = {
  kind: "app",
  describe: {
    label: "Phone-app blocker (iOS Family Controls / Android Usage Access)",
  },

  async verifyAvailable(): Promise<BlockerAvailability> {
    const status = await getAppBlockerStatus();
    if (!status.available) {
      return {
        available: false,
        reason:
          status.reason ?? "App blocking is not available on this device.",
        permission: "denied",
      };
    }
    const permission = ((): BlockerAvailability["permission"] => {
      switch (status.permissionStatus) {
        case "granted":
          return "granted";
        case "denied":
          return "denied";
        default:
          return "prompt";
      }
    })();
    return {
      available: true,
      reason: null,
      permission,
    };
  },

  async start(request: BlockAppsOptions): Promise<BlockAppsResult> {
    return startAppBlock(request);
  },

  async stop(): Promise<void> {
    const result = await stopAppBlock();
    if (!result.success) {
      throw new Error(result.error ?? "Failed to remove app block.");
    }
  },

  async status(): Promise<BlockerStatusSummary> {
    const status = await getAppBlockerStatus();
    if (!status.available) {
      return {
        active: false,
        endsAt: null,
        text: status.reason ?? "App blocking is not available on this device.",
      };
    }
    if (!status.active) {
      return {
        active: false,
        endsAt: null,
        text: "No app block is active right now.",
      };
    }
    const countText = `${status.blockedCount} app${status.blockedCount !== 1 ? "s" : ""}`;
    const untilText = status.endsAt
      ? `until ${status.endsAt}`
      : "until you remove it";
    return {
      active: true,
      endsAt: status.endsAt,
      text: `An app block is active for ${countText} ${untilText}.`,
    };
  },
};
