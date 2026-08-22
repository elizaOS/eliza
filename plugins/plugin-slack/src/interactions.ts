/**
 * Projects canonical interaction blocks onto Slack Block Kit action elements.
 * Unsupported blocks remain actionable prose, and every marker is stripped
 * before either the accessibility fallback or visible message is returned.
 */

import {
  buildInteractionUrlResolver,
  type Content,
  encodePreparedInteractionCallback,
  type IAgentRuntime,
  type InteractionBlock,
  type PreparedMessageInteraction,
  parseInteractionBlocks,
  renderContentInteractionsAsPlainText,
  stripDashboardOnlyMarkers,
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

function slackButton(args: {
  label: string;
  value?: string;
  url?: string;
  index: number;
}) {
  if (!args.url && !args.value) return null;
  return {
    type: "button",
    text: {
      type: "plain_text",
      text: args.label,
      emoji: true,
      verbatim: undefined,
    },
    action_id: `eliza_prepared_interaction_${args.index}`,
    url: args.url,
    value: args.value,
    style: undefined,
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

  const text = renderContentInteractionsAsPlainText(content, options).text;
  return {
    text,
    blocks: [],
    needsFreeTextReply: true,
    outcome: "fallback",
  };
}

/** Render only host-prepared authority as provider-native Block Kit controls. */
export function renderPreparedSlackInteraction(
  prepared: PreparedMessageInteraction,
  options: SlackInteractionOptions = {},
): SlackInteractionRender {
  const block = prepared.block;
  if (prepared.delivery.mode !== "native") {
    return {
      text: renderContentInteractionsAsPlainText({ interactions: [block] }, options).text,
      blocks: [],
      needsFreeTextReply: true,
      outcome: "fallback",
    };
  }
  const optionsToRender =
    block.kind === "choice"
      ? block.options.map((option) => ({ label: option.label, value: option.value }))
      : block.kind === "followups"
        ? block.options
            .filter((option) => option.kind !== "navigate")
            .map((option) => ({ label: option.label, value: option.payload }))
        : [];
  const elements = optionsToRender
    .map((option, index) => {
      const value = encodePreparedInteractionCallback(
        prepared.callbackData,
        { value: option.value },
        MAX_CALLBACK_BYTES,
      );
      return value ? slackButton({ label: option.label, value, index }) : null;
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
  if (elements.length !== optionsToRender.length || elements.length === 0) {
    return {
      text: renderContentInteractionsAsPlainText({ interactions: [block] }, options).text,
      blocks: [],
      needsFreeTextReply: true,
      outcome: "fallback",
    };
  }
  const rows = Array.from(
    { length: Math.ceil(elements.length / MAX_BUTTONS_PER_ACTIONS_BLOCK) },
    (_, index) => elements.slice(index * MAX_BUTTONS_PER_ACTIONS_BLOCK, (index + 1) * MAX_BUTTONS_PER_ACTIONS_BLOCK),
  );
  if (rows.length > MAX_BLOCKS_PER_MESSAGE) {
    return {
      text: renderContentInteractionsAsPlainText({ interactions: [block] }, options).text,
      blocks: [],
      needsFreeTextReply: true,
      outcome: "fallback",
    };
  }
  return {
    text: stripDashboardOnlyMarkers(
      block.kind === "choice" ? block.prompt ?? "Choose an option." : "Choose an option.",
    ),
    blocks: rows.map((row) => ({ type: "actions", elements: row, text: undefined })),
    needsFreeTextReply: false,
    outcome: "native",
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
