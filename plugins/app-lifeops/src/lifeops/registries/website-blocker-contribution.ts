/**
 * W2-F — Website-blocker enforcer.
 *
 * Wraps the `website-blocker` engine (hosts-file editor + iOS/Android native
 * backends when registered) as a {@link BlockerContribution}. The umbrella
 * `WEBSITE_BLOCK` action dispatches through this entry instead of importing
 * engine functions directly so adding a new website-blocker backend is a
 * registration call.
 */

import {
  formatWebsiteList,
  getSelfControlStatus,
  getSelfControlPermissionState,
  type SelfControlBlockRequest,
  startSelfControlBlock,
  stopSelfControlBlock,
} from "../../website-blocker/engine.js";
import type {
  BlockerAvailability,
  BlockerContribution,
  BlockerStatusSummary,
} from "./blocker-registry.js";

export type WebsiteBlockerStartResult =
  | { success: true; endsAt: string | null }
  | {
      success: false;
      error: string;
      status?: Awaited<ReturnType<typeof getSelfControlStatus>>;
    };

export const websiteBlockerContribution: BlockerContribution<
  SelfControlBlockRequest,
  WebsiteBlockerStartResult
> = {
  kind: "website",
  describe: { label: "Website blocker (hosts-file / native)" },

  async verifyAvailable(): Promise<BlockerAvailability> {
    const status = await getSelfControlStatus();
    if (!status.available) {
      return {
        available: false,
        reason:
          status.reason ?? "Local website blocking is unavailable on this machine.",
        permission: "denied",
      };
    }
    const permissionState = await getSelfControlPermissionState();
    const permission = ((): BlockerAvailability["permission"] => {
      switch (permissionState.status) {
        case "granted":
          return "granted";
        case "not-determined":
          return permissionState.canRequest ? "prompt" : "denied";
        case "denied":
          return "denied";
        default:
          return permissionState.canRequest ? "prompt" : "denied";
      }
    })();
    return {
      available: true,
      reason: null,
      permission,
    };
  },

  async start(
    request: SelfControlBlockRequest,
  ): Promise<WebsiteBlockerStartResult> {
    return startSelfControlBlock(request);
  },

  async stop(): Promise<void> {
    const result = await stopSelfControlBlock();
    if (result.success === false) {
      throw new Error(result.error);
    }
  },

  async status(): Promise<BlockerStatusSummary> {
    const status = await getSelfControlStatus();
    if (!status.available) {
      return {
        active: false,
        endsAt: null,
        text:
          status.reason ?? "Local website blocking is unavailable on this machine.",
      };
    }
    if (!status.active) {
      return {
        active: false,
        endsAt: null,
        text: "No website block is active right now.",
      };
    }
    const websites =
      status.websites.length > 0
        ? formatWebsiteList(status.websites)
        : "an unknown website set";
    const text = status.endsAt
      ? `A website block is active for ${websites} until ${status.endsAt}.`
      : `A website block is active for ${websites} until you remove it.`;
    return {
      active: true,
      endsAt: status.endsAt,
      text,
    };
  },
};
