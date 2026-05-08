import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { getSelfControlAccess } from "../website-blocker/access.js";
import { getCachedSelfControlStatus } from "../website-blocker/engine.js";

export const websiteBlockerProvider: Provider = {
  name: "websiteBlocker",
  description:
    "Owner-only provider for the local hosts-file website blocker integration. Use WEBSITE_BLOCK for website blocking (timed focus blocks, generic distraction blocks, or fixed duration).",
  descriptionCompressed: "Owner: hosts-file website blocker.",
  dynamic: true,
  contexts: ["screen_time", "settings"],
  contextGate: { anyOf: ["screen_time", "settings"] },
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const access = await getSelfControlAccess(runtime, message);
    if (!access.allowed) {
      return {
        text: "",
        values: {
          websiteBlockerAuthorized: false,
          selfControlAuthorized: false,
        },
        data: {
          websiteBlockerAuthorized: false,
          selfControlAuthorized: false,
        },
      };
    }

    let status;
    try {
      status = await getCachedSelfControlStatus();
    } catch (error) {
      return {
        text: "Local website blocking status unavailable.",
        values: {
          websiteBlockerAuthorized: true,
          websiteBlockerAvailable: false,
          selfControlAuthorized: true,
          selfControlAvailable: false,
        },
        data: {
          websiteBlockerAuthorized: true,
          websiteBlockerAvailable: false,
          selfControlAuthorized: true,
          selfControlAvailable: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (!status.available) {
      return {
        text:
          status.reason ??
          "Local website blocking is unavailable on this machine.",
        values: {
          websiteBlockerAuthorized: true,
          websiteBlockerAvailable: false,
          websiteBlockerCanUnblockEarly: false,
          websiteBlockerRequiresElevation: status.requiresElevation,
          websiteBlockerSupportsElevationPrompt: status.supportsElevationPrompt,
          websiteBlockerElevationPromptMethod: status.elevationPromptMethod,
          websiteBlockerEngine: status.engine,
          websiteBlockerPlatform: status.platform,
          selfControlAuthorized: true,
          selfControlAvailable: false,
          selfControlCanUnblockEarly: false,
          selfControlSupportsElevationPrompt: status.supportsElevationPrompt,
          selfControlElevationPromptMethod: status.elevationPromptMethod,
        },
        data: {
          websiteBlockerAuthorized: true,
          websiteBlockerAvailable: false,
          websiteBlockerCanUnblockEarly: false,
          websiteBlockerRequiresElevation: status.requiresElevation,
          websiteBlockerSupportsElevationPrompt: status.supportsElevationPrompt,
          websiteBlockerElevationPromptMethod: status.elevationPromptMethod,
          websiteBlockerEngine: status.engine,
          websiteBlockerPlatform: status.platform,
          selfControlAuthorized: true,
          selfControlAvailable: false,
          selfControlCanUnblockEarly: false,
          selfControlSupportsElevationPrompt: status.supportsElevationPrompt,
          selfControlElevationPromptMethod: status.elevationPromptMethod,
        },
      };
    }

    const statusLine = status.active
      ? status.endsAt
        ? `A website block is active until ${status.endsAt}.`
        : "A website block is active until you remove it."
      : "No website block is active right now.";

    return {
      text: [
        "Local website blocking is available through the system hosts file.",
        statusLine,
        status.reason ??
          "Eliza can remove the block early when it has permission to edit the hosts file.",
      ].join(" "),
      values: {
        websiteBlockerAuthorized: true,
        websiteBlockerAvailable: true,
        websiteBlockerActive: status.active,
        websiteBlockerEndsAt: status.endsAt,
        websiteBlockerCanUnblockEarly: status.canUnblockEarly,
        websiteBlockerRequiresElevation: status.requiresElevation,
        websiteBlockerSupportsElevationPrompt: status.supportsElevationPrompt,
        websiteBlockerElevationPromptMethod: status.elevationPromptMethod,
        websiteBlockerHostsFilePath: status.hostsFilePath,
        websiteBlockerEngine: status.engine,
        websiteBlockerPlatform: status.platform,
        selfControlAuthorized: true,
        selfControlAvailable: true,
        selfControlActive: status.active,
        selfControlEndsAt: status.endsAt,
        selfControlCanUnblockEarly: status.canUnblockEarly,
        selfControlSupportsElevationPrompt: status.supportsElevationPrompt,
        selfControlElevationPromptMethod: status.elevationPromptMethod,
        selfControlHostsFilePath: status.hostsFilePath,
      },
      data: {
        websiteBlockerAuthorized: true,
        websiteBlockerAvailable: true,
        websiteBlockerActive: status.active,
        websiteBlockerEndsAt: status.endsAt,
        websiteBlockerCanUnblockEarly: status.canUnblockEarly,
        websiteBlockerRequiresElevation: status.requiresElevation,
        websiteBlockerSupportsElevationPrompt: status.supportsElevationPrompt,
        websiteBlockerElevationPromptMethod: status.elevationPromptMethod,
        websiteBlockerHostsFilePath: status.hostsFilePath,
        websiteBlockerEngine: status.engine,
        websiteBlockerPlatform: status.platform,
        selfControlAuthorized: true,
        selfControlAvailable: true,
        selfControlActive: status.active,
        selfControlEndsAt: status.endsAt,
        selfControlCanUnblockEarly: status.canUnblockEarly,
        selfControlSupportsElevationPrompt: status.supportsElevationPrompt,
        selfControlElevationPromptMethod: status.elevationPromptMethod,
        selfControlHostsFilePath: status.hostsFilePath,
      },
    };
  },
};
