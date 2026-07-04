/**
 * CONNECT_ACCOUNT — surface the in-chat "add another account" entry point.
 *
 * When the user asks to add / connect / log into another AI provider account
 * ("add another claude account", "connect a second codex account", "sign in
 * with a different account"), this action emits an `accountConnect` structured
 * field on the assistant turn. The chat renderer turns that into the
 * `AccountConnectBlock` (per-provider count + "Add account") which opens the
 * existing, already-audited `AddAccountDialog` OAuth / API-key flow. The action
 * does NOT create or manage credentials itself — it only offers the shortcut.
 *
 * Provider ids are sourced from SUBSCRIPTION_PROVIDER_METADATA; only providers
 * whose availability is "available" are offered. Claude → "anthropic-subscription",
 * Codex → "openai-codex". When the user doesn't name a provider, both are offered.
 */

import {
  SUBSCRIPTION_PROVIDER_METADATA,
  type SubscriptionProvider,
} from "@elizaos/auth/types";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";

const CONNECT_ACCOUNT = "CONNECT_ACCOUNT";

/**
 * Subscription providers that can be connected in-chat, in offer order. Only
 * providers whose availability is "available" and whose add-account surface is
 * an OAuth login are offered here — the two we can drive end-to-end from the
 * chat block (Claude subscription + OpenAI Codex).
 */
const CONNECTABLE_PROVIDERS = [
  "anthropic-subscription",
  "openai-codex",
] as const satisfies readonly SubscriptionProvider[];

type ConnectableProvider = (typeof CONNECTABLE_PROVIDERS)[number];

/** Words that signal an intent to ADD/CONNECT a new account (not switch/remove). */
const ADD_INTENT_TERMS = [
  "add",
  "connect",
  "link",
  "sign in",
  "sign-in",
  "signin",
  "log in",
  "log-in",
  "login",
  "hook up",
  "attach",
  "authorize",
  "authorise",
];

/** Words that anchor the intent to an account/provider login (not e.g. a contact). */
const ACCOUNT_ANCHOR_TERMS = [
  "account",
  "claude",
  "anthropic",
  "codex",
  "openai",
  "subscription",
  "provider",
];

function normalize(text: string): string {
  return text.toLowerCase();
}

/**
 * True when the message expresses intent to add/connect another provider
 * account. Requires both an add-style verb AND an account/provider anchor so
 * unrelated "add a reminder" / "connect to the wifi" text does not match.
 */
export function messageWantsAccountConnect(text: string): boolean {
  const normalized = normalize(text);
  const hasAddVerb = ADD_INTENT_TERMS.some((term) => normalized.includes(term));
  if (!hasAddVerb) return false;
  const hasAnchor = ACCOUNT_ANCHOR_TERMS.some((term) =>
    normalized.includes(term),
  );
  return hasAnchor;
}

/** Resolve which connectable providers the user meant from their text. */
export function resolveRequestedProviders(text: string): ConnectableProvider[] {
  const normalized = normalize(text);
  const mentionsClaude =
    normalized.includes("claude") || normalized.includes("anthropic");
  const mentionsCodex =
    normalized.includes("codex") || normalized.includes("openai");

  const available = CONNECTABLE_PROVIDERS.filter(
    (id) => SUBSCRIPTION_PROVIDER_METADATA[id].availability === "available",
  );

  if (mentionsClaude && !mentionsCodex) {
    return available.filter((id) => id === "anthropic-subscription");
  }
  if (mentionsCodex && !mentionsClaude) {
    return available.filter((id) => id === "openai-codex");
  }
  // Unspecified (or both named) — offer every available connectable provider.
  return available;
}

function providerDisplayName(id: ConnectableProvider): string {
  return SUBSCRIPTION_PROVIDER_METADATA[id].displayName;
}

export const connectAccountAction: Action = {
  name: CONNECT_ACCOUNT,
  contexts: ["settings", "messaging"],
  similes: [
    "ADD_ACCOUNT",
    "ADD_PROVIDER_ACCOUNT",
    "CONNECT_PROVIDER_ACCOUNT",
    "LINK_ACCOUNT",
    "SIGN_IN_ANOTHER_ACCOUNT",
    "LOG_IN_ANOTHER_ACCOUNT",
    "ADD_CLAUDE_ACCOUNT",
    "ADD_CODEX_ACCOUNT",
  ],
  description:
    "Offer to connect ANOTHER AI provider account (Claude / OpenAI Codex) from " +
    "chat. Use when the user asks to add, connect, or sign into an additional " +
    "provider account. Emits an inline entry point that opens the account-add " +
    "flow; it does not create credentials directly.",
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
  ): Promise<boolean> => {
    const text =
      typeof message.content.text === "string" ? message.content.text : "";
    if (!text.trim()) return false;
    return messageWantsAccountConnect(text);
  },
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text =
      typeof message.content.text === "string" ? message.content.text : "";
    const providers = resolveRequestedProviders(text);

    if (providers.length === 0) {
      const errorText =
        "No connectable provider accounts are available right now.";
      if (callback) {
        await callback({ text: errorText, action: CONNECT_ACCOUNT });
      }
      return {
        success: false,
        text: errorText,
        values: { success: false, error: "NO_CONNECTABLE_PROVIDERS" },
        data: {
          actionName: CONNECT_ACCOUNT,
          error: "NO_CONNECTABLE_PROVIDERS",
        },
      };
    }

    const names = providers.map(providerDisplayName);
    const reason =
      providers.length === 1
        ? `You asked to connect another ${names[0]} account.`
        : "You asked to connect another provider account.";
    const replyText =
      providers.length === 1
        ? `Sure — pick "Add account" below to sign into another ${names[0]} account.`
        : `Sure — pick a provider below (${names.join(" or ")}) to sign into another account.`;

    // The `accountConnect` field on the Content is what the SSE / conversation
    // serializer carries to the client, where MessageContent swaps in the
    // AccountConnectBlock. Text is the fallback for surfaces that don't render
    // the structured block.
    if (callback) {
      await callback({
        text: replyText,
        action: CONNECT_ACCOUNT,
        accountConnect: { providers, reason },
      });
    }

    logger.info(
      { providers },
      "[CONNECT_ACCOUNT] Offered in-chat account connect",
    );

    return {
      success: true,
      text: replyText,
      values: { success: true, providersStr: providers.join(",") },
      data: {
        actionName: CONNECT_ACCOUNT,
        accountConnect: { providers, reason },
      },
    };
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "add another claude account" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Sure — pick "Add account" below to sign into another Claude Subscription account.',
          action: CONNECT_ACCOUNT,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "I want to connect a second codex account" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Sure — pick "Add account" below to sign into another OpenAI Codex account.',
          action: CONNECT_ACCOUNT,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "log into another account" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Sure — pick a provider below to sign into another account.",
          action: CONNECT_ACCOUNT,
        },
      },
    ],
  ] as ActionExample[][],
};
