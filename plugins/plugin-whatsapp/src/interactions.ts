/**
 * Projects canonical interaction blocks onto WhatsApp Cloud API reply buttons
 * or lists. Baileys and unsupported/multi-block payloads use the complete
 * semantic text projection; raw marker bodies never reach either transport.
 */

import {
  buildInteractionUrlResolver,
  type Content,
  encodePreparedInteractionCallback,
  type IAgentRuntime,
  type PreparedMessageInteraction,
  parseInteractionBlocks,
  renderContentInteractionsAsPlainText,
} from "@elizaos/core";
import type { WhatsAppInteractiveMessage } from "./types";

export interface WhatsAppInteractionRender {
  text: string;
  interactive?: WhatsAppInteractiveMessage;
  outcome: "plain" | "native" | "fallback";
  reason?: "multiple-blocks" | "unsupported-kind" | "provider-limit" | "link-action";
}

function appUrlOptions(runtime: Pick<IAgentRuntime, "getSetting">) {
  const raw = runtime.getSetting("ELIZA_APP_URL") ?? runtime.getSetting("ELIZA_CLOUD_URL");
  return buildInteractionUrlResolver(typeof raw === "string" ? raw : undefined);
}

/** Render a Cloud API message, using provider-native controls only when lossless. */
export function renderWhatsAppInteractions(
  runtime: Pick<IAgentRuntime, "getSetting">,
  content: Content
): WhatsAppInteractionRender {
  const parsed = parseInteractionBlocks(content.text ?? "");
  const interactions = content.interactions?.length ? content.interactions : parsed.blocks;
  if (interactions.length === 0) {
    return { text: parsed.cleanedText, outcome: "plain" };
  }
  const fallback = renderContentInteractionsAsPlainText(content, appUrlOptions(runtime)).text;
  if (interactions.length !== 1) {
    return { text: fallback, outcome: "fallback", reason: "multiple-blocks" };
  }

  return { text: fallback, outcome: "fallback", reason: "unsupported-kind" };
}

/** Render only a host-prepared interaction as Cloud API reply controls. */
export function renderPreparedWhatsAppInteraction(
  prepared: PreparedMessageInteraction
): WhatsAppInteractionRender {
  const interaction = prepared.block;
  const fallback = renderContentInteractionsAsPlainText({ interactions: [interaction] }).text;
  if (
    prepared.delivery.mode !== "native" ||
    (interaction.kind !== "choice" && interaction.kind !== "followups") ||
    (interaction.kind === "followups" &&
      interaction.options.some((option) => option.kind === "navigate"))
  ) {
    return { text: fallback, outcome: "fallback", reason: "unsupported-kind" };
  }
  const providerOptions =
    interaction.kind === "choice"
      ? interaction.options.map((option) => ({
          label: option.label,
          value: option.value,
        }))
      : interaction.options.map((option) => ({
          label: option.label,
          value: option.payload,
        }));
  const callbackButtons = providerOptions.map((option) => ({
    label: option.label,
    callbackData: encodePreparedInteractionCallback(
      prepared.callbackData,
      { value: option.value },
      200
    ),
  }));
  if (
    callbackButtons.length === 0 ||
    callbackButtons.length > 10 ||
    callbackButtons.some((button) => !button.callbackData)
  ) {
    return { text: fallback, outcome: "fallback", reason: "provider-limit" };
  }

  const bodyText =
    (interaction.kind === "choice" ? interaction.prompt?.trim() : "") || "Choose an option.";
  if (callbackButtons.length <= 3 && callbackButtons.every((button) => button.label.length <= 20)) {
    return {
      text: bodyText,
      outcome: "native",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: callbackButtons.map((button) => ({
            type: "reply" as const,
            reply: { id: button.callbackData as string, title: button.label },
          })),
        },
      },
    };
  }
  if (callbackButtons.some((button) => button.label.length > 24)) {
    return { text: fallback, outcome: "fallback", reason: "provider-limit" };
  }
  return {
    text: bodyText,
    outcome: "native",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: "Choose",
        sections: [
          {
            rows: callbackButtons.map((button) => ({
              id: button.callbackData as string,
              title: button.label,
            })),
          },
        ],
      },
    },
  };
}
