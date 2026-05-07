import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { getSelfControlAccess } from "../website-blocker/access.ts";
import { getCachedSelfControlStatus } from "../website-blocker/engine.ts";

export const websiteBlockerProvider: Provider = {
  name: "websiteBlocker",
  description:
    "Owner-only provider for the local hosts-file website blocker integration. Use WEBSITE_BLOCK for timed or generic focus blocks, and BLOCK_UNTIL_TASK_COMPLETE only when the unblock condition is finishing a task.",
  descriptionCompressed: "Owner: hosts-file website blocker.",
  dynamic: true,
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

    const status = await getCachedSelfControlStatus();
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
