/**
 * Scenario blueprints for synthetic training data generation.
 *
 * Each blueprint describes a canonical conversation scenario. The generator
 * expands each blueprint into multiple variants by randomizing:
 * - Agent name (prevents statistical name pollution)
 * - Participant names and count
 * - Platform (telegram, discord, slack, etc.)
 * - Tone, length, and distractor turns
 * - Context specificity (subtle → explicit)
 *
 * Blueprints are categorized by:
 * 1. Decision type: RESPOND | IGNORE | STOP
 * 2. Context domain: general, wallet, knowledge, etc.
 * 3. Conversation pattern: group_chat, group_noise, multi_turn_intent, etc.
 */

import { ACTION_CONTEXT_MAP, PROVIDER_CONTEXT_MAP } from "./context-catalog.js";
import { AGENT_CONTEXTS, type AgentContext } from "./context-types.js";

export interface ScenarioBlueprint {
  /** Unique blueprint ID */
  id: string;
  /** Expected shouldRespond decision */
  decision: "RESPOND" | "IGNORE" | "STOP";
  /** Expected primary context */
  primaryContext: AgentContext;
  /** Expected secondary contexts */
  secondaryContexts?: AgentContext[];
  /** Conversation pattern type */
  pattern:
    | "group_direct_mention"
    | "group_reply_chain"
    | "group_subtle_mention"
    | "group_noise"
    | "group_about_agent"
    | "group_multi_turn_intent"
    | "group_stop_request"
    | "group_wrong_agent"
    | "group_long_context"
    | "group_action_emergence";
  /** Brief description of the scenario */
  description: string;
  /** Minimum turns before the key message */
  minContextTurns: number;
  /** Maximum turns before the key message */
  maxContextTurns: number;
  /** Action that should be triggered (if RESPOND + action-bearing) */
  expectedAction?: string;
  /** Keywords that should appear in the conversation to ground the scenario */
  groundingKeywords: string[];
  /** Prompt hint for the teacher model when generating this scenario */
  generationHint: string;
}

type ScenarioPattern = ScenarioBlueprint["pattern"];

// ==================== RESPOND scenarios ====================

const respondGeneral: ScenarioBlueprint[] = [
  {
    id: "respond-general-direct-mention-001",
    decision: "RESPOND",
    primaryContext: "general",
    pattern: "group_direct_mention",
    description: "Someone directly asks the agent a general question",
    minContextTurns: 2,
    maxContextTurns: 8,
    groundingKeywords: ["hey", "what do you think", "can you help"],
    generationHint:
      "Generate a group chat where participants discuss random topics, then one person directly addresses the agent by name with a general question.",
  },
  {
    id: "respond-general-reply-chain-001",
    decision: "RESPOND",
    primaryContext: "general",
    pattern: "group_reply_chain",
    description: "Agent is in an active reply chain and should continue",
    minContextTurns: 4,
    maxContextTurns: 12,
    groundingKeywords: ["thanks", "follow up", "what about"],
    generationHint:
      "Generate a group chat where the agent has been actively replying, and the conversation continues with follow-up questions directed at the agent.",
  },
  {
    id: "respond-general-subtle-mention-001",
    decision: "RESPOND",
    primaryContext: "general",
    pattern: "group_subtle_mention",
    description:
      "Agent's name is mentioned subtly in a question that requires response",
    minContextTurns: 3,
    maxContextTurns: 10,
    groundingKeywords: ["mentioned", "asked"],
    generationHint:
      "Generate a group chat where someone mentions the agent's name mid-sentence while asking it something. The mention should be natural, not a formal address.",
  },
];

const respondWallet: ScenarioBlueprint[] = [
  {
    id: "respond-wallet-balance-001",
    decision: "RESPOND",
    primaryContext: "wallet",
    pattern: "group_direct_mention",
    description: "Someone asks the agent to check a token balance",
    minContextTurns: 1,
    maxContextTurns: 5,
    expectedAction: "CHECK_BALANCE",
    groundingKeywords: ["balance", "tokens", "how much", "wallet"],
    generationHint:
      "Generate a group chat about crypto, then someone asks the agent by name to check their token balance.",
  },
  {
    id: "respond-wallet-swap-001",
    decision: "RESPOND",
    primaryContext: "wallet",
    secondaryContexts: ["automation"],
    pattern: "group_direct_mention",
    description: "Someone asks the agent to swap tokens",
    minContextTurns: 2,
    maxContextTurns: 6,
    expectedAction: "SWAP_TOKEN",
    groundingKeywords: ["swap", "exchange", "trade", "convert"],
    generationHint:
      "Generate a group chat where users discuss token prices, then someone asks the agent to swap ETH for USDC or similar.",
  },
  {
    id: "respond-wallet-send-001",
    decision: "RESPOND",
    primaryContext: "wallet",
    pattern: "group_direct_mention",
    description: "Someone asks the agent to send tokens",
    minContextTurns: 1,
    maxContextTurns: 4,
    expectedAction: "SEND_TOKEN",
    groundingKeywords: ["send", "transfer", "to address"],
    generationHint:
      "Generate a group chat where someone asks the agent to send tokens to a specific address.",
  },
  {
    id: "respond-wallet-multi-turn-001",
    decision: "RESPOND",
    primaryContext: "wallet",
    pattern: "group_multi_turn_intent",
    description:
      "Wallet intent emerges over multiple turns of discussion before explicit request",
    minContextTurns: 6,
    maxContextTurns: 15,
    expectedAction: "SWAP_TOKEN",
    groundingKeywords: ["price", "market", "dip", "buy", "swap", "good time"],
    generationHint:
      "Generate a long group chat where users discuss market conditions, token prices, and eventually one person decides to ask the agent to execute a swap. The intent should emerge gradually over several messages.",
  },
];

const respondKnowledge: ScenarioBlueprint[] = [
  {
    id: "respond-knowledge-search-001",
    decision: "RESPOND",
    primaryContext: "knowledge",
    pattern: "group_direct_mention",
    description: "Someone asks the agent to look something up",
    minContextTurns: 2,
    maxContextTurns: 6,
    expectedAction: "SEARCH_KNOWLEDGE",
    groundingKeywords: ["search", "find", "look up", "what is"],
    generationHint:
      "Generate a group chat where someone asks the agent a factual question that requires knowledge lookup.",
  },
  {
    id: "respond-knowledge-summarize-001",
    decision: "RESPOND",
    primaryContext: "knowledge",
    pattern: "group_reply_chain",
    description: "Agent is asked to summarize a discussion",
    minContextTurns: 8,
    maxContextTurns: 20,
    expectedAction: "SUMMARIZE",
    groundingKeywords: ["summarize", "tldr", "recap", "main points"],
    generationHint:
      "Generate a long group discussion about a complex topic, then someone asks the agent to summarize the key points.",
  },
];

const respondMedia: ScenarioBlueprint[] = [
  {
    id: "respond-media-image-001",
    decision: "RESPOND",
    primaryContext: "media",
    pattern: "group_direct_mention",
    description: "Someone asks the agent to generate an image",
    minContextTurns: 1,
    maxContextTurns: 5,
    expectedAction: "GENERATE_IMAGE",
    groundingKeywords: ["generate", "create", "make", "image", "picture"],
    generationHint:
      "Generate a group chat where someone asks the agent to generate an image of something specific.",
  },
  {
    id: "respond-media-describe-001",
    decision: "RESPOND",
    primaryContext: "media",
    secondaryContexts: ["knowledge"],
    pattern: "group_direct_mention",
    description: "Someone shares an image and asks the agent to describe it",
    minContextTurns: 1,
    maxContextTurns: 4,
    expectedAction: "DESCRIBE_IMAGE",
    groundingKeywords: ["describe", "what is this", "what do you see"],
    generationHint:
      "Generate a group chat where someone shares an image attachment and asks the agent what it shows.",
  },
];

const respondAutomation: ScenarioBlueprint[] = [
  {
    id: "respond-automation-cron-001",
    decision: "RESPOND",
    primaryContext: "automation",
    pattern: "group_direct_mention",
    description: "Someone asks the agent to set up a scheduled task",
    minContextTurns: 2,
    maxContextTurns: 6,
    expectedAction: "CREATE_CRON",
    groundingKeywords: [
      "schedule",
      "every day",
      "remind me",
      "recurring",
      "cron",
    ],
    generationHint:
      "Generate a group chat where someone asks the agent to set up a daily reminder or scheduled task.",
  },
];

const respondSocial: ScenarioBlueprint[] = [
  {
    id: "respond-social-contact-001",
    decision: "RESPOND",
    primaryContext: "social",
    pattern: "group_direct_mention",
    description: "Someone asks the agent to look up contact information",
    minContextTurns: 1,
    maxContextTurns: 5,
    expectedAction: "SEARCH_CONTACTS",
    groundingKeywords: ["contact", "who is", "find", "look up"],
    generationHint:
      "Generate a group chat where someone asks the agent to find information about a contact.",
  },
];

const respondCode: ScenarioBlueprint[] = [
  {
    id: "respond-code-task-001",
    decision: "RESPOND",
    primaryContext: "code",
    secondaryContexts: ["automation"],
    pattern: "group_direct_mention",
    description: "Someone asks the agent to spawn a sub-agent for a task",
    minContextTurns: 3,
    maxContextTurns: 8,
    expectedAction: "SPAWN_AGENT",
    groundingKeywords: ["agent", "spawn", "create", "task", "automate"],
    generationHint:
      "Generate a group chat where developers discuss a problem, then someone asks the agent to spawn a sub-agent to handle a specific automated task.",
  },
];

const respondSystem: ScenarioBlueprint[] = [
  {
    id: "respond-system-config-001",
    decision: "RESPOND",
    primaryContext: "system",
    pattern: "group_direct_mention",
    description: "Someone asks the agent to change a configuration setting",
    minContextTurns: 1,
    maxContextTurns: 4,
    expectedAction: "CONFIGURE",
    groundingKeywords: ["config", "setting", "change", "update"],
    generationHint:
      "Generate a group chat where someone asks the agent to update a runtime configuration.",
  },
];

// ==================== IGNORE scenarios ====================

const ignoreScenarios: ScenarioBlueprint[] = [
  {
    id: "ignore-noise-001",
    decision: "IGNORE",
    primaryContext: "general",
    pattern: "group_noise",
    description:
      "Group chat with unrelated conversation - agent not mentioned at all",
    minContextTurns: 5,
    maxContextTurns: 15,
    groundingKeywords: [],
    generationHint:
      "Generate a group chat where people discuss lunch plans, weekend activities, or other casual topics. The agent's name should NOT appear at all.",
  },
  {
    id: "ignore-noise-002",
    decision: "IGNORE",
    primaryContext: "general",
    pattern: "group_noise",
    description:
      "Technical discussion between humans with no agent involvement",
    minContextTurns: 4,
    maxContextTurns: 12,
    groundingKeywords: ["code", "bug", "fix", "deploy"],
    generationHint:
      "Generate a group chat where developers discuss code reviews and deployment issues among themselves. The agent should NOT be mentioned.",
  },
  {
    id: "ignore-about-agent-001",
    decision: "IGNORE",
    primaryContext: "general",
    pattern: "group_about_agent",
    description:
      "People talk ABOUT the agent but not TO the agent - should still IGNORE",
    minContextTurns: 3,
    maxContextTurns: 8,
    groundingKeywords: ["it", "the bot", "that agent"],
    generationHint:
      'Generate a group chat where people discuss the agent in third person ("the bot did X", "I think it can do Y") but never address it directly. The agent should IGNORE this.',
  },
  {
    id: "ignore-about-agent-002",
    decision: "IGNORE",
    primaryContext: "wallet",
    pattern: "group_about_agent",
    description:
      "People discuss the agent's wallet capabilities without addressing it",
    minContextTurns: 4,
    maxContextTurns: 10,
    groundingKeywords: ["can it swap", "does it support", "the bot handles"],
    generationHint:
      "Generate a group chat where users discuss the agent's DeFi capabilities in third person without addressing it directly.",
  },
  {
    id: "ignore-wrong-agent-001",
    decision: "IGNORE",
    primaryContext: "general",
    pattern: "group_wrong_agent",
    description: "Someone addresses a DIFFERENT bot by name in the group",
    minContextTurns: 3,
    maxContextTurns: 8,
    groundingKeywords: ["hey", "can you"],
    generationHint:
      "Generate a group chat with TWO different bots present. Someone addresses the OTHER bot by name. The agent being tested should IGNORE this.",
  },
  {
    id: "ignore-wrong-agent-002",
    decision: "IGNORE",
    primaryContext: "wallet",
    pattern: "group_wrong_agent",
    description: "Someone asks a DIFFERENT bot to do a wallet operation",
    minContextTurns: 2,
    maxContextTurns: 6,
    groundingKeywords: ["swap", "send", "balance"],
    generationHint:
      "Generate a group chat where someone asks a DIFFERENT bot (not our agent) to check a wallet balance or swap tokens.",
  },
  {
    id: "ignore-long-noise-001",
    decision: "IGNORE",
    primaryContext: "general",
    pattern: "group_long_context",
    description:
      "Very long group conversation with no agent involvement at all",
    minContextTurns: 15,
    maxContextTurns: 30,
    groundingKeywords: [],
    generationHint:
      "Generate a very long group chat (20+ messages) of casual conversation between friends. The agent should NOT be mentioned at all.",
  },
  {
    id: "ignore-partial-name-001",
    decision: "IGNORE",
    primaryContext: "general",
    pattern: "group_noise",
    description:
      "Someone mentions a word that partially matches the agent's name but is a different word",
    minContextTurns: 3,
    maxContextTurns: 8,
    groundingKeywords: [],
    generationHint:
      "Generate a group chat where someone uses a word that partially contains the agent's name (e.g., if agent is 'Max', someone says 'maximize'). The agent should IGNORE this.",
  },
];

// ==================== STOP scenarios ====================

const stopScenarios: ScenarioBlueprint[] = [
  {
    id: "stop-explicit-001",
    decision: "STOP",
    primaryContext: "general",
    pattern: "group_stop_request",
    description: "Someone explicitly tells the agent to stop talking",
    minContextTurns: 4,
    maxContextTurns: 10,
    groundingKeywords: ["stop", "shut up", "be quiet", "enough"],
    generationHint:
      "Generate a group chat where the agent has been participating, and then someone tells it to stop or be quiet.",
  },
  {
    id: "stop-polite-001",
    decision: "STOP",
    primaryContext: "general",
    pattern: "group_stop_request",
    description: "Someone politely asks the agent to stop",
    minContextTurns: 3,
    maxContextTurns: 8,
    groundingKeywords: [
      "please stop",
      "that's enough",
      "no more",
      "thanks but",
    ],
    generationHint:
      "Generate a group chat where the agent has been active, and someone politely asks it to stop responding or take a break.",
  },
  {
    id: "stop-mute-001",
    decision: "STOP",
    primaryContext: "general",
    pattern: "group_stop_request",
    description: "Someone asks to mute the agent in the channel",
    minContextTurns: 2,
    maxContextTurns: 6,
    groundingKeywords: ["mute", "disable", "turn off", "silence"],
    generationHint:
      "Generate a group chat where someone asks to mute or disable the agent in the current channel.",
  },
];

// ==================== Multi-turn intent emergence ====================

const multiTurnIntentScenarios: ScenarioBlueprint[] = [
  {
    id: "respond-multi-turn-wallet-001",
    decision: "RESPOND",
    primaryContext: "wallet",
    pattern: "group_action_emergence",
    description:
      "Over several turns, users discuss token prices and one gradually decides to swap",
    minContextTurns: 8,
    maxContextTurns: 20,
    expectedAction: "SWAP_TOKEN",
    groundingKeywords: [
      "price",
      "market",
      "down",
      "buy the dip",
      "should I",
      "let's do it",
    ],
    generationHint:
      "Generate a LONG group conversation where 3-4 users discuss crypto market conditions. One user gradually moves from observing to deciding to trade. The intent to swap should emerge naturally over 5+ messages. The final message should clearly direct the agent to execute.",
  },
  {
    id: "respond-multi-turn-knowledge-001",
    decision: "RESPOND",
    primaryContext: "knowledge",
    pattern: "group_action_emergence",
    description:
      "Group debates a topic, eventually asks agent to research and settle the argument",
    minContextTurns: 6,
    maxContextTurns: 15,
    expectedAction: "SEARCH_KNOWLEDGE",
    groundingKeywords: [
      "actually",
      "I think",
      "no way",
      "look it up",
      "settle this",
    ],
    generationHint:
      "Generate a group chat where people argue about a factual question. After several turns of disagreement, someone asks the agent to look it up and settle the debate.",
  },
  {
    id: "respond-multi-turn-automation-001",
    decision: "RESPOND",
    primaryContext: "automation",
    pattern: "group_action_emergence",
    description:
      "Team discusses a recurring problem, eventually asks agent to automate a solution",
    minContextTurns: 6,
    maxContextTurns: 15,
    expectedAction: "CREATE_CRON",
    groundingKeywords: [
      "keeps happening",
      "every time",
      "automate",
      "daily",
      "schedule",
    ],
    generationHint:
      "Generate a group chat where team members discuss a recurring manual task that frustrates them. Over several turns, they realize the agent could automate it. Someone finally asks the agent to set up a scheduled job.",
  },
];

type LeadInStyle = {
  id: string;
  description: string;
  hint: string;
  extraKeywords: string[];
};

type ScenarioRecipe = {
  id: string;
  pattern: ScenarioPattern;
  minContextTurns: number;
  maxContextTurns: number;
  description: string;
  hint: string;
};

const GENERATED_ACTION_SKIP = new Set(["NONE", "IGNORE", "STOP"]);

const CONTEXT_KEYWORDS: Record<AgentContext, string[]> = {
  general: ["question", "follow up", "chat", "group"],
  wallet: ["wallet", "token", "swap", "balance"],
  knowledge: ["research", "lookup", "answer", "facts"],
  browser: ["link", "site", "page", "browser"],
  code: ["repo", "patch", "bug", "script"],
  media: ["image", "audio", "video", "describe"],
  automation: ["schedule", "workflow", "repeat", "automate"],
  social: ["contact", "message", "reply", "people"],
  system: ["setting", "runtime", "config", "permissions"],
};

const LEAD_IN_STYLES: LeadInStyle[] = [
  {
    id: "casual",
    description: "casual chatter",
    hint: "Start with lightweight group-chat banter before the key ask lands.",
    extraKeywords: ["hey", "lol", "anyway"],
  },
  {
    id: "operational",
    description: "operational planning",
    hint: "Frame the lead-in as a practical coordination thread with real constraints.",
    extraKeywords: ["need", "today", "ship"],
  },
  {
    id: "debate",
    description: "debate and disagreement",
    hint: "Make the lead-in a mild disagreement where the ask resolves uncertainty or friction.",
    extraKeywords: ["actually", "wait", "settle"],
  },
];

const ACTION_RECIPES: ScenarioRecipe[] = [
  {
    id: "direct-short",
    pattern: "group_direct_mention",
    minContextTurns: 1,
    maxContextTurns: 5,
    description: "direct short request",
    hint: "The final message should directly address the agent by name with an explicit request.",
  },
  {
    id: "subtle-short",
    pattern: "group_subtle_mention",
    minContextTurns: 2,
    maxContextTurns: 7,
    description: "subtle mention request",
    hint: "Mention the agent naturally mid-sentence instead of using a formal command.",
  },
  {
    id: "reply-chain",
    pattern: "group_reply_chain",
    minContextTurns: 4,
    maxContextTurns: 10,
    description: "reply-chain continuation",
    hint: "Treat the ask as a continuation of an active thread where the agent has already been part of the exchange.",
  },
  {
    id: "multi-turn-intent",
    pattern: "group_multi_turn_intent",
    minContextTurns: 5,
    maxContextTurns: 12,
    description: "multi-turn intent buildup",
    hint: "The same user should build intent across several messages before finally asking the agent to act.",
  },
  {
    id: "action-emergence",
    pattern: "group_action_emergence",
    minContextTurns: 8,
    maxContextTurns: 18,
    description: "long action emergence",
    hint: "Let the action intent emerge gradually from a longer group conversation before the final explicit ask.",
  },
  {
    id: "long-context",
    pattern: "group_long_context",
    minContextTurns: 10,
    maxContextTurns: 22,
    description: "long-context request",
    hint: "Make the lead-in long and partly unrelated so the messageHandler router must use the recent window rather than just the final line.",
  },
];

const PROVIDER_RECIPES: ScenarioRecipe[] = [
  {
    id: "provider-direct",
    pattern: "group_direct_mention",
    minContextTurns: 2,
    maxContextTurns: 6,
    description: "direct provider request",
    hint: "The final ask should clearly require pulling in contextual data before answering.",
  },
  {
    id: "provider-subtle",
    pattern: "group_subtle_mention",
    minContextTurns: 3,
    maxContextTurns: 8,
    description: "subtle provider request",
    hint: "The request should be natural and indirect but still require the provider-backed context.",
  },
];

const IGNORE_RECIPES: ScenarioRecipe[] = [
  {
    id: "noise",
    pattern: "group_noise",
    minContextTurns: 4,
    maxContextTurns: 12,
    description: "pure human conversation",
    hint: "The agent should not be mentioned at all.",
  },
  {
    id: "about-agent",
    pattern: "group_about_agent",
    minContextTurns: 4,
    maxContextTurns: 12,
    description: "people talking about the agent",
    hint: "Participants may reference the agent in third person, but they must not talk to it.",
  },
  {
    id: "wrong-agent",
    pattern: "group_wrong_agent",
    minContextTurns: 3,
    maxContextTurns: 10,
    description: "another assistant is addressed",
    hint: "A different assistant should be addressed directly while the trained agent should stay uninvolved.",
  },
  {
    id: "long-noise",
    pattern: "group_long_context",
    minContextTurns: 12,
    maxContextTurns: 24,
    description: "long unrelated thread",
    hint: "Keep the chat long enough that the agent has to ignore a noisy but context-heavy conversation.",
  },
];

const STOP_RECIPES: ScenarioRecipe[] = [
  {
    id: "explicit",
    pattern: "group_stop_request",
    minContextTurns: 3,
    maxContextTurns: 9,
    description: "explicit stop request",
    hint: "Someone should clearly tell the agent to stop responding in the channel.",
  },
  {
    id: "polite",
    pattern: "group_stop_request",
    minContextTurns: 3,
    maxContextTurns: 8,
    description: "polite stop request",
    hint: "The stop request should be polite but unambiguous.",
  },
  {
    id: "moderator",
    pattern: "group_stop_request",
    minContextTurns: 4,
    maxContextTurns: 10,
    description: "moderator intervention",
    hint: "Frame the stop request as a moderator or channel-owner intervention.",
  },
];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function humanizeToken(value: string): string {
  return value.toLowerCase().replace(/_/g, " ");
}

function uniqueList(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function describeActionIntent(
  actionName: string,
  primaryContext: AgentContext,
): string {
  const readable = humanizeToken(actionName);
  switch (primaryContext) {
    case "wallet":
      return `perform the wallet action "${readable}"`;
    case "knowledge":
      return `help with a knowledge task around "${readable}"`;
    case "browser":
      return `use browser capabilities to "${readable}"`;
    case "code":
      return `handle a coding or tooling task to "${readable}"`;
    case "media":
      return `handle a media workflow to "${readable}"`;
    case "automation":
      return `set up or run automation to "${readable}"`;
    case "social":
      return `help with a social coordination task to "${readable}"`;
    case "system":
      return `apply a runtime or system change to "${readable}"`;
    default:
      return `handle the request "${readable}"`;
  }
}

function buildGroundingKeywords(
  seed: string[],
  primaryContext: AgentContext,
  leadIn: LeadInStyle,
): string[] {
  return uniqueList([
    ...seed,
    ...CONTEXT_KEYWORDS[primaryContext],
    ...leadIn.extraKeywords,
  ]).slice(0, 8);
}

function createGeneratedActionScenarios(): ScenarioBlueprint[] {
  const blueprints: ScenarioBlueprint[] = [];

  for (const [actionName, contexts] of Object.entries(ACTION_CONTEXT_MAP)) {
    if (GENERATED_ACTION_SKIP.has(actionName)) continue;
    const [primaryContext, ...secondaryContexts] = contexts;
    if (!primaryContext) continue;

    for (const recipe of ACTION_RECIPES) {
      for (const leadIn of LEAD_IN_STYLES) {
        const readableAction = humanizeToken(actionName);
        blueprints.push({
          id: `generated-respond-${slugify(actionName)}-${recipe.id}-${leadIn.id}`,
          decision: "RESPOND",
          primaryContext,
          secondaryContexts,
          pattern: recipe.pattern,
          description: `${describeActionIntent(actionName, primaryContext)} in ${leadIn.description} using ${recipe.description}`,
          minContextTurns: recipe.minContextTurns,
          maxContextTurns: recipe.maxContextTurns,
          expectedAction: actionName,
          groundingKeywords: buildGroundingKeywords(
            readableAction.split(" "),
            primaryContext,
            leadIn,
          ),
          generationHint: [
            `Generate a group chat where the final user intent is to ${describeActionIntent(actionName, primaryContext)}.`,
            `The conversation should clearly live in the ${primaryContext} context.`,
            recipe.hint,
            leadIn.hint,
            secondaryContexts.length > 0
              ? `Blend in these secondary contexts when natural: ${secondaryContexts.join(", ")}.`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        });
      }
    }
  }

  return blueprints;
}

function createGeneratedProviderScenarios(): ScenarioBlueprint[] {
  const blueprints: ScenarioBlueprint[] = [];

  for (const [providerName, contexts] of Object.entries(PROVIDER_CONTEXT_MAP)) {
    const [primaryContext, ...secondaryContexts] = contexts;
    if (!primaryContext) continue;

    for (const recipe of PROVIDER_RECIPES) {
      for (const leadIn of LEAD_IN_STYLES) {
        blueprints.push({
          id: `generated-provider-${slugify(providerName)}-${recipe.id}-${leadIn.id}`,
          decision: "RESPOND",
          primaryContext,
          secondaryContexts,
          pattern: recipe.pattern,
          description: `request that should require the "${providerName}" provider in ${leadIn.description}`,
          minContextTurns: recipe.minContextTurns,
          maxContextTurns: recipe.maxContextTurns,
          groundingKeywords: buildGroundingKeywords(
            providerName
              .split(/(?=[A-Z])|_/)
              .map((token) => token.toLowerCase()),
            primaryContext,
            leadIn,
          ),
          generationHint: [
            `Generate a group chat where answering well requires provider-backed context similar to "${providerName}".`,
            `Keep the primary context in ${primaryContext}.`,
            recipe.hint,
            leadIn.hint,
          ].join(" "),
        });
      }
    }
  }

  return blueprints;
}

function createGeneratedIgnoreScenarios(): ScenarioBlueprint[] {
  const blueprints: ScenarioBlueprint[] = [];

  for (const context of AGENT_CONTEXTS) {
    for (const recipe of IGNORE_RECIPES) {
      for (const leadIn of LEAD_IN_STYLES.slice(0, 2)) {
        blueprints.push({
          id: `generated-ignore-${context}-${recipe.id}-${leadIn.id}`,
          decision: "IGNORE",
          primaryContext: context,
          pattern: recipe.pattern,
          description: `ignore case for ${context} during ${recipe.description} with ${leadIn.description}`,
          minContextTurns: recipe.minContextTurns,
          maxContextTurns: recipe.maxContextTurns,
          groundingKeywords: buildGroundingKeywords([], context, leadIn),
          generationHint: [
            `Generate a ${context}-flavored group chat that should still be ignored by the agent.`,
            recipe.hint,
            leadIn.hint,
            `Do not create a valid direct ask for the agent in this sample.`,
          ].join(" "),
        });
      }
    }
  }

  return blueprints;
}

function createGeneratedStopScenarios(): ScenarioBlueprint[] {
  return STOP_RECIPES.flatMap((recipe) =>
    LEAD_IN_STYLES.map((leadIn) => ({
      id: `generated-stop-${recipe.id}-${leadIn.id}`,
      decision: "STOP" as const,
      primaryContext: "general" as const,
      pattern: recipe.pattern,
      description: `${recipe.description} after ${leadIn.description}`,
      minContextTurns: recipe.minContextTurns,
      maxContextTurns: recipe.maxContextTurns,
      groundingKeywords: buildGroundingKeywords(
        ["stop", "quiet", "enough"],
        "general",
        leadIn,
      ),
      generationHint: [
        "Generate a group chat where the agent has been active enough for a stop request to make sense.",
        recipe.hint,
        leadIn.hint,
      ].join(" "),
    })),
  );
}

const generatedActionScenarios = createGeneratedActionScenarios();
const generatedProviderScenarios = createGeneratedProviderScenarios();
const generatedIgnoreScenarios = createGeneratedIgnoreScenarios();
const generatedStopScenarios = createGeneratedStopScenarios();

function dedupeBlueprints(
  blueprints: ScenarioBlueprint[],
): ScenarioBlueprint[] {
  const seen = new Set<string>();
  return blueprints.filter((blueprint) => {
    if (seen.has(blueprint.id)) return false;
    seen.add(blueprint.id);
    return true;
  });
}

/**
 * All scenario blueprints, flattened.
 */
export const ALL_BLUEPRINTS: ScenarioBlueprint[] = dedupeBlueprints([
  ...respondGeneral,
  ...respondWallet,
  ...respondKnowledge,
  ...respondMedia,
  ...respondAutomation,
  ...respondSocial,
  ...respondCode,
  ...respondSystem,
  ...ignoreScenarios,
  ...stopScenarios,
  ...multiTurnIntentScenarios,
  ...generatedActionScenarios,
  ...generatedProviderScenarios,
  ...generatedIgnoreScenarios,
  ...generatedStopScenarios,
]);

export const BLUEPRINT_STATS = {
  manualCount:
    respondGeneral.length +
    respondWallet.length +
    respondKnowledge.length +
    respondMedia.length +
    respondAutomation.length +
    respondSocial.length +
    respondCode.length +
    respondSystem.length +
    ignoreScenarios.length +
    stopScenarios.length +
    multiTurnIntentScenarios.length,
  generatedActionCount: generatedActionScenarios.length,
  generatedProviderCount: generatedProviderScenarios.length,
  generatedIgnoreCount: generatedIgnoreScenarios.length,
  generatedStopCount: generatedStopScenarios.length,
  totalCount: ALL_BLUEPRINTS.length,
} as const;

/**
 * Get blueprints by decision type.
 */
export function getBlueprintsByDecision(
  decision: "RESPOND" | "IGNORE" | "STOP",
): ScenarioBlueprint[] {
  return ALL_BLUEPRINTS.filter((b) => b.decision === decision);
}

/**
 * Get blueprints by context.
 */
export function getBlueprintsByContext(
  context: AgentContext,
): ScenarioBlueprint[] {
  return ALL_BLUEPRINTS.filter(
    (b) =>
      b.primaryContext === context || b.secondaryContexts?.includes(context),
  );
}
