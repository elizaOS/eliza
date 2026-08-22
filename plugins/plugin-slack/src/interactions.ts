/**
 * Projects canonical interaction blocks onto Slack Block Kit action elements.
 * Unsupported blocks remain actionable prose, and every marker is stripped
 * before either the accessibility fallback or visible message is returned.
 */

import {
  buildInteractionUrlResolver,
  type Content,
  type IAgentRuntime,
  type InteractionBlock,
  type NeutralButton,
  parseInteractionBlocks,
  stripDashboardOnlyMarkers,
  toNeutralLayout,
} from "@elizaos/core";
import type { SlackBlock } from "./types";

const MAX_BUTTONS_PER_ACTIONS_BLOCK = 5;
const MAX_BLOCKS_PER_MESSAGE = 50;
const MAX_CALLBACK_BYTES = 2_000;

export interface SlackInteractionRender {
  text: string;
  blocks: SlackBlock[];
  needsFreeTextReply: boolean;
  outcome: "plain" | "native" | "fallback";
}

export interface SlackInteractionOptions {
  resolveUrl?: (block: InteractionBlock) => string | undefined;
  resolveNavigateUrl?: (payload: string) => string | undefined;
}

function slackButton(button: NeutralButton, index: number) {
  if (!button.url && !button.callbackData) return null;
  return {
    type: "button",
    text: {
      type: "plain_text",
      text: button.label,
      emoji: true,
      verbatim: undefined,
    },
    actionId: `eliza_interaction_${index}`,
    url: button.url,
    value: button.callbackData,
    style:
      button.style === "danger"
        ? "danger"
        : button.style === "primary"
          ? "primary"
          : undefined,
  };
}

/** Render one outbound content value to provider-valid Block Kit. */
export function renderSlackInteractions(
  content: Content,
  options: SlackInteractionOptions = {},
): SlackInteractionRender {
  const { blocks: interactions, cleanedText } = parseInteractionBlocks(
    content.text ?? "",
  );
  const sourceBlocks = content.interactions?.length
    ? content.interactions
    : interactions;
  if (sourceBlocks.length === 0) {
    return {
      text: cleanedText,
      blocks: [],
      needsFreeTextReply: false,
      outcome: "plain",
    };
  }

  const blocks: SlackBlock[] = [];
  const fallback: string[] = [];
  let needsFreeTextReply = false;
  let actionIndex = 0;

  for (const interaction of sourceBlocks) {
    const layout = toNeutralLayout(interaction, {
      ...options,
      maxButtonsPerRow: MAX_BUTTONS_PER_ACTIONS_BLOCK,
      maxCallbackBytes: MAX_CALLBACK_BYTES,
    });
    let rendered = false;
    for (const row of layout.rows) {
      const rowButtons = row.buttons ?? [];
      const elements = rowButtons
        .map((button) => slackButton(button, actionIndex++))
        .filter(
          (button): button is NonNullable<typeof button> => button !== null,
        );
      if (elements.length === 0) continue;
      if (blocks.length >= MAX_BLOCKS_PER_MESSAGE) {
        fallback.push(
          ...rowButtons.map((button) =>
            button.url ? `${button.label} (${button.url})` : button.label,
          ),
        );
        needsFreeTextReply = true;
        continue;
      }
      blocks.push({
        type: "actions",
        blockId: undefined,
        elements,
        text: undefined,
      });
      rendered = true;
    }
    if (layout.needsFallback) needsFreeTextReply = true;
    if (!rendered && layout.text) fallback.push(layout.text);
  }

  const text = stripDashboardOnlyMarkers(
    [cleanedText, ...fallback].filter((part) => part.trim()).join("\n\n"),
  );
  return {
    text,
    blocks,
    needsFreeTextReply,
    outcome:
      blocks.length > 0
        ? needsFreeTextReply
          ? "fallback"
          : "native"
        : "fallback",
  };
}

/** Resolve task/auth links from the configured app origin for the send path. */
export function buildSlackInteractionPayload(
  runtime: Pick<IAgentRuntime, "getSetting">,
  content: Content,
): SlackInteractionRender {
  const rawAppUrl =
    runtime.getSetting("ELIZA_APP_URL") ??
    runtime.getSetting("ELIZA_CLOUD_URL");
  return renderSlackInteractions(
    content,
    buildInteractionUrlResolver(
      typeof rawAppUrl === "string" ? rawAppUrl : undefined,
    ),
  );
}
