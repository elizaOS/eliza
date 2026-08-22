/**
 * Projects canonical interaction blocks onto WhatsApp Cloud API reply buttons
 * or lists. Baileys and unsupported/multi-block payloads use the complete
 * semantic text projection; raw marker bodies never reach either transport.
 */

import {
  buildInteractionUrlResolver,
  type Content,
  type IAgentRuntime,
  type NeutralButton,
  parseInteractionBlocks,
  renderContentInteractionsAsPlainText,
  stripDashboardOnlyMarkers,
  toNeutralLayout,
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

  const interaction = interactions[0];
  if (interaction.kind !== "choice" && interaction.kind !== "followups") {
    return { text: fallback, outcome: "fallback", reason: "unsupported-kind" };
  }
  if (
    interaction.kind === "followups" &&
    interaction.options.some((option) => option.kind === "navigate")
  ) {
    return { text: fallback, outcome: "fallback", reason: "link-action" };
  }

  const layout = toNeutralLayout(interaction, {
    maxButtonsPerRow: 3,
    maxCallbackBytes: 200,
  });
  const buttons = layout.rows.flatMap((row) => row.buttons ?? []);
  if (
    layout.needsFallback ||
    buttons.length === 0 ||
    buttons.length > 10 ||
    buttons.some((button) => !button.callbackData || button.url)
  ) {
    return { text: fallback, outcome: "fallback", reason: "provider-limit" };
  }
  const callbackButtons = buttons.filter(
    (button): button is NeutralButton & { callbackData: string; url?: never } =>
      Boolean(button.callbackData) && !button.url
  );

  const bodyText =
    stripDashboardOnlyMarkers(parsed.cleanedText).trim() ||
    (interaction.kind === "choice" ? interaction.prompt?.trim() : "") ||
    "Choose an option.";
  if (callbackButtons.length <= 3 && callbackButtons.every((button) => button.label.length <= 20)) {
    return {
      text: parsed.cleanedText,
      outcome: "native",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: callbackButtons.map((button) => ({
            type: "reply" as const,
            reply: { id: button.callbackData, title: button.label },
          })),
        },
      },
    };
  }
  if (callbackButtons.some((button) => button.label.length > 24)) {
    return { text: fallback, outcome: "fallback", reason: "provider-limit" };
  }
  return {
    text: parsed.cleanedText,
    outcome: "native",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: "Choose",
        sections: [
          {
            rows: callbackButtons.map((button) => ({
              id: button.callbackData,
              title: button.label,
            })),
          },
        ],
      },
    },
  };
}
