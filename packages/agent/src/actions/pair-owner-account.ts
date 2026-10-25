/**
 * PAIR_OWNER_ACCOUNT — the owner-side entry point of the connector
 * owner-pairing flow. When the app owner asks to link/verify their Discord or
 * Telegram account ("link my discord", "pair my telegram account"), this
 * action issues a one-time 6-digit code via {@link OwnerBindingService} and
 * replies with the exact connector command to run (`/eliza-pair <code>` on
 * Discord, `/eliza_pair <code>` on Telegram). The connector relays the code
 * back to the `OWNER_BIND_VERIFY` service, which binds the proven platform
 * identity to the canonical owner entity — after which role resolution treats
 * that platform user as OWNER everywhere.
 *
 * Authorization is double-gated: the declared `roleGate` keeps the action out
 * of non-owner planner surfaces, and the handler re-checks `hasOwnerAccess`
 * so a bypassed gate still fails closed. The code is revealed only in the
 * reply to the requesting (owner) surface, never pushed to the connector.
 */
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
import { hasOwnerAccess } from "../security/access.ts";
import {
  type OwnerBindConnector,
  resolveOwnerBindingService,
} from "../services/owner-binding.ts";

const PAIR_OWNER_ACCOUNT = "PAIR_OWNER_ACCOUNT";

/** Connectors that ship a pairing command today, with the command to run. */
const PAIRABLE_CONNECTORS: ReadonlyArray<{
  connector: OwnerBindConnector;
  displayName: string;
  /** Exact command the owner runs on the platform (naming differs because
   *  Telegram bot commands cannot contain hyphens). */
  command: string;
  /** Terms in the owner's message that select this connector. */
  terms: readonly string[];
}> = [
  {
    connector: "discord",
    displayName: "Discord",
    command: "/eliza-pair",
    terms: ["discord"],
  },
  {
    connector: "telegram",
    displayName: "Telegram",
    command: "/eliza_pair",
    terms: ["telegram"],
  },
];

/** Verbs that signal a link/pair/verify intent. */
const PAIR_INTENT_TERMS = [
  "link",
  "pair",
  "bind",
  "verify",
  "connect",
  "prove",
];

function normalize(text: string): string {
  return text.toLowerCase();
}

/** The pairable connector named in the text, or null when none/ambiguous. */
export function resolveRequestedPairConnector(
  text: string,
): (typeof PAIRABLE_CONNECTORS)[number] | null {
  const normalized = normalize(text);
  const mentioned = PAIRABLE_CONNECTORS.filter((entry) =>
    entry.terms.some((term) => normalized.includes(term)),
  );
  return mentioned.length === 1 ? (mentioned[0] ?? null) : null;
}

/**
 * True when the message expresses intent to pair/link an owner platform
 * account. Requires both a pair-style verb AND a supported connector name so
 * unrelated "link this doc" / "connect the printer" text does not match.
 */
export function messageWantsOwnerPairing(text: string): boolean {
  const normalized = normalize(text);
  const hasVerb = PAIR_INTENT_TERMS.some((term) => normalized.includes(term));
  if (!hasVerb) return false;
  return PAIRABLE_CONNECTORS.some((entry) =>
    entry.terms.some((term) => normalized.includes(term)),
  );
}

function failure(text: string, error: string): ActionResult {
  return {
    success: false,
    text,
    values: { success: false, error },
    data: { actionName: PAIR_OWNER_ACCOUNT, error },
  };
}

export const pairOwnerAccountAction: Action = {
  name: PAIR_OWNER_ACCOUNT,
  contexts: ["settings", "messaging"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "LINK_MY_DISCORD",
    "LINK_MY_TELEGRAM",
    "PAIR_DISCORD_ACCOUNT",
    "PAIR_TELEGRAM_ACCOUNT",
    "VERIFY_OWNER_ACCOUNT",
    "BIND_OWNER_ACCOUNT",
  ],
  description:
    "Link the app owner's Discord or Telegram account to their owner " +
    "identity. Issues a one-time pairing code and tells the owner which " +
    "command to run on the platform; once verified, messages from that " +
    "platform account are recognized as the owner. Owner-only.",
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
  ): Promise<boolean> => {
    const text =
      typeof message.content.text === "string" ? message.content.text : "";
    if (!text.trim()) return false;
    return messageWantsOwnerPairing(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    // Defense in depth: the roleGate already scopes planner exposure, but the
    // pairing code grants OWNER to whoever redeems it, so the handler itself
    // must refuse any sender that does not resolve to the owner.
    if (!(await hasOwnerAccess(runtime, message))) {
      const text =
        "Only the app owner can link an owner account. Ask the owner to run this from their own chat.";
      if (callback) {
        await callback({ text, action: PAIR_OWNER_ACCOUNT });
      }
      return failure(text, "NOT_OWNER");
    }

    const messageText =
      typeof message.content.text === "string" ? message.content.text : "";
    const target = resolveRequestedPairConnector(messageText);
    if (!target) {
      const names = PAIRABLE_CONNECTORS.map((c) => c.displayName).join(" or ");
      const text = `Which account should I link — ${names}?`;
      if (callback) {
        await callback({ text, action: PAIR_OWNER_ACCOUNT });
      }
      return failure(text, "CONNECTOR_AMBIGUOUS");
    }

    const service = resolveOwnerBindingService(runtime);
    if (!service) {
      const text =
        "Owner pairing is not available right now (the pairing service is not running).";
      if (callback) {
        await callback({ text, action: PAIR_OWNER_ACCOUNT });
      }
      return failure(text, "SERVICE_UNAVAILABLE");
    }

    let issued: ReturnType<typeof service.beginOwnerBind>;
    try {
      issued = service.beginOwnerBind({ connector: target.connector });
    } catch (err) {
      // error-policy:J4 explicit user-facing degrade — the one expected
      // failure is "no canonical owner configured", surfaced as a designed
      // unavailable reply; every failure is also reported for repair.
      runtime.reportError("agent:pair-owner-account", err, {
        connector: target.connector,
      });
      const text =
        "I couldn't issue a pairing code. Finish app setup first so an owner identity exists, then try again.";
      if (callback) {
        await callback({ text, action: PAIR_OWNER_ACCOUNT });
      }
      return failure(text, "ISSUE_FAILED");
    }

    const minutes = Math.round((issued.expiresAt - Date.now()) / 60_000);
    const replyText =
      `Here's your ${target.displayName} pairing code: **${issued.code}**\n\n` +
      `Run \`${target.command} ${issued.code}\` ${
        target.connector === "discord"
          ? "in any server or DM with me on Discord"
          : "in your Telegram chat with me"
      }. The code is single-use and expires in ${minutes > 0 ? minutes : 5} minutes. ` +
      "Don't share it — whoever redeems it is recognized as the owner.";

    if (callback) {
      await callback({ text: replyText, action: PAIR_OWNER_ACCOUNT });
    }

    logger.info(
      {
        src: "agent:pair-owner-account",
        agentId: runtime.agentId,
        connector: target.connector,
      },
      "Issued owner pairing code via chat",
    );

    return {
      success: true,
      text: replyText,
      values: { success: true, connector: target.connector },
      data: {
        actionName: PAIR_OWNER_ACCOUNT,
        connector: target.connector,
        expiresAt: issued.expiresAt,
      },
    };
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "link my discord account" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here's your Discord pairing code: **123456** — run `/eliza-pair 123456` in any server or DM with me on Discord.",
          action: PAIR_OWNER_ACCOUNT,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "pair my telegram so you know it's me" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here's your Telegram pairing code: **654321** — run `/eliza_pair 654321` in your Telegram chat with me.",
          action: PAIR_OWNER_ACCOUNT,
        },
      },
    ],
  ] as ActionExample[][],
};
