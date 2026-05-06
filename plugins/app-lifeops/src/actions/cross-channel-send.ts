import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { LifeOpsService } from "../lifeops/service.js";

type SendOptions = {
  parameters?: {
    channel?: string;
    target?: string;
    message?: string;
    body?: string;
  };
};

function optionParameters(options: unknown): SendOptions["parameters"] {
  return (options as SendOptions | undefined)?.parameters ?? {};
}

export const crossChannelSendAction: Action = {
  name: "OWNER_SEND_MESSAGE",
  description:
    "Legacy compatibility wrapper for owner-approved cross-channel chat sends.",
  descriptionCompressed:
    "send approved owner message through registered chat connector",
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: SendOptions,
  ): Promise<ActionResult> => {
    const parameters = optionParameters(options);
    const channel = parameters.channel?.trim() || "telegram";
    const target = parameters.target?.trim();
    const text = parameters.message ?? parameters.body ?? "";
    const service = new LifeOpsService(runtime);
    void service;

    if (!target || !text.trim()) {
      return {
        success: false,
        text: "Missing message target or body.",
        data: {
          actionName: "OWNER_SEND_MESSAGE",
          result: { routedBy: "SEND_MESSAGE", source: channel },
        },
      };
    }

    await runtime.sendMessageToTarget(
      { source: channel, channelId: target },
      { text, source: channel },
    );

    return {
      success: true,
      text: `Sent ${channel} message to ${target}.`,
      data: {
        actionName: "OWNER_SEND_MESSAGE",
        result: { routedBy: "SEND_MESSAGE", source: channel },
      },
    };
  },
};
