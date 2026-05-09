/**
 * Eliza n8n runtime-context provider — registers as service type
 * `workflow_runtime_context_provider` so the patched `@elizaos/plugin-workflow`
 * can pull connector facts (Discord guilds + channels, Gmail email, supported
 * credential types) into the workflow-generation prompt.
 *
 * Why this exists (Session 19, post-dogfood):
 *   The plugin's `WORKFLOW_GENERATION_SYSTEM_PROMPT` previously emitted
 *   placeholders like `guildId: "={{YOUR_SERVER_ID}}"` because the LLM had
 *   no way to know the user's actual Discord server/channel IDs. This service
 *   surfaces real values so the LLM substitutes them verbatim and so the
 *   credential block lands on every relevant node.
 *
 * Shape returned to the plugin:
 *
 *   getRuntimeContext({userId, relevantNodes, relevantCredTypes}) →
 *     {
 *       supportedCredentials: [{ credType, friendlyName, nodeTypes[] }, ...],
 *       facts: [
 *         "Discord guild \"2PM\" (id 1471687731594657792) channels: ...",
 *         "Connected Gmail account: rodolfomanhaes@gmail.com.",
 *         ...
 *       ],
 *     }
 *
 * Failures degrade silently (empty facts) — the plugin still generates a
 * workflow, just without runtime substitutions.
 */

import type { AgentRuntime } from "@elizaos/core";
import {
  createDiscordSourceCache,
  type DiscordSourceCache,
  fetchDiscordEnumeration,
  formatDiscordEnumerationAsFacts,
} from "./discord-target-source";

const SERVICE_TYPE = "workflow_runtime_context_provider";

/**
 * Subset of `ElizaConfig.connectors` the provider reads. Inlined so this
 * service has no compile-time dependency on a sibling credential provider —
 * hosts that already have one can ignore this shape, hosts that don't can
 * still register a getConfig() that returns a literal of this type.
 */
export interface ConnectorConfigLike {
  connectors?: {
    discord?: { enabled?: boolean; token?: string };
    telegram?: { enabled?: boolean; botToken?: string };
    gmail?: {
      enabled?: boolean;
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
      email?: string;
    };
    slack?: {
      enabled?: boolean;
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
    };
  };
}

/**
 * Cred types this provider considers when filtering `supportedCredentials`
 * before returning them to the plugin. Hosts that can satisfy a different
 * set should pass their own filter via `credProvider.resolve()`.
 *
 * Kept in sync with `CRED_TYPE_FACTS` below — every entry here must also
 * have a `CRED_TYPE_FACTS[type]` entry, otherwise it silently drops at the
 * `!meta` guard in `computeSupportedCredentials` (Greptile P1 caught
 * `discordWebhookApi` and `googleOAuth2Api` previously listed here without
 * fact entries).
 */
const ELIZA_SUPPORTED_CRED_TYPES: ReadonlySet<string> = new Set([
  "discordApi",
  "discordBotApi",
  "telegramApi",
  "gmailOAuth2",
  "gmailOAuth2Api",
  "googleSheetsOAuth2Api",
  "googleCalendarOAuth2Api",
  "googleDriveOAuth2Api",
  "slackApi",
  "slackOAuth2Api",
]);

interface RuntimeContextSupportedCredential {
  credType: string;
  friendlyName: string;
  nodeTypes: string[];
}

export interface RuntimeContext {
  supportedCredentials: RuntimeContextSupportedCredential[];
  facts: string[];
}

/** Mirrors the plugin's `NodeDefinition.credentials` shape (subset). */
interface PluginNodeDefinition {
  name: string;
  displayName?: string;
  credentials?: Array<{ name: string; required?: boolean }>;
}

/**
 * Originating-conversation routing context. Hosts pass this when the workflow
 * is being generated from inside a platform conversation (e.g. a Discord DM),
 * so the LLM can target "this channel" / "back to me" without the user
 * naming an ID.
 *
 * Mirrors the shape introduced upstream in `@elizaos/plugin-workflow` —
 * the host duplicates the type so it doesn't need to import from the plugin.
 */
export interface TriggerContext {
  source?: string;
  discord?: { channelId?: string; guildId?: string; threadId?: string };
  telegram?: { chatId?: string | number; threadId?: string | number };
  slack?: { channelId?: string; teamId?: string };
  resolvedNames?: { channel?: string; server?: string };
}

interface RuntimeContextProviderInput {
  userId: string;
  relevantNodes: PluginNodeDefinition[];
  relevantCredTypes: string[];
  triggerContext?: TriggerContext;
}

/**
 * Static map: which n8n cred types match which n8n node types, plus a
 * human-friendly name for the credential block. Filtered at runtime against
 * `ELIZA_SUPPORTED_CRED_TYPES` AND against which connectors are actually
 * configured (no point listing `gmailOAuth2` as available when the user
 * hasn't run the OAuth flow).
 */
const CRED_TYPE_FACTS: Record<
  string,
  { friendlyName: string; nodeTypes: string[] }
> = {
  discordApi: {
    friendlyName: "Discord Bot",
    nodeTypes: ["n8n-nodes-base.discord"],
  },
  discordBotApi: {
    friendlyName: "Discord Bot",
    nodeTypes: ["n8n-nodes-base.discord"],
  },
  telegramApi: {
    friendlyName: "Telegram Bot",
    nodeTypes: ["n8n-nodes-base.telegram", "n8n-nodes-base.telegramTrigger"],
  },
  gmailOAuth2: {
    friendlyName: "Gmail Account",
    nodeTypes: ["n8n-nodes-base.gmail", "n8n-nodes-base.gmailTrigger"],
  },
  gmailOAuth2Api: {
    friendlyName: "Gmail Account",
    nodeTypes: ["n8n-nodes-base.gmail", "n8n-nodes-base.gmailTrigger"],
  },
  googleSheetsOAuth2Api: {
    friendlyName: "Google Sheets",
    nodeTypes: ["n8n-nodes-base.googleSheets"],
  },
  googleCalendarOAuth2Api: {
    friendlyName: "Google Calendar",
    nodeTypes: ["n8n-nodes-base.googleCalendar"],
  },
  googleDriveOAuth2Api: {
    friendlyName: "Google Drive",
    nodeTypes: ["n8n-nodes-base.googleDrive"],
  },
  slackOAuth2Api: {
    friendlyName: "Slack Workspace",
    nodeTypes: ["n8n-nodes-base.slack"],
  },
  slackApi: {
    friendlyName: "Slack Workspace",
    nodeTypes: ["n8n-nodes-base.slack"],
  },
};

/**
 * Subset of the cred provider's resolve() return values. We only check
 * whether a cred type is actually satisfiable (`credential_data`) vs not
 * yet wired (`needs_auth`) so we can filter `supportedCredentials` to
 * connectors the user has actually configured.
 */
type CredResolveResult =
  | { status: "credential_data"; data: Record<string, unknown> }
  | { status: "needs_auth"; authUrl: string }
  | null;

interface CredProviderLike {
  resolve(userId: string, credType: string): Promise<CredResolveResult>;
}

export interface ElizaN8nRuntimeContextProviderOptions {
  /** Re-read on every call so connector edits do not require a restart. */
  getConfig: () => ConnectorConfigLike;
  /**
   * Reference to the credential provider so we can ask which cred types
   * actually have data right now (vs `needs_auth`). Optional — without it
   * we fall back to "config has connector token" heuristics.
   */
  credProvider?: CredProviderLike;
  /** Test injection seam — defaults to fetch. */
  fetchImpl?: typeof fetch;
  /** Test injection seam — defaults to Date.now. */
  now?: () => number;
  /**
   * Optional shared Discord enumeration cache. When supplied, the catalog
   * service can pass the same instance so a `generate` then a quick-pick
   * `resolve-clarification` round-trip uses one REST window instead of two.
   */
  discordCache?: DiscordSourceCache;
}

export interface ElizaN8nRuntimeContextProviderHandle {
  service: {
    getRuntimeContext: (
      input: RuntimeContextProviderInput,
    ) => Promise<RuntimeContext>;
    stop: () => Promise<void>;
    capabilityDescription: string;
  };
  stop: () => void;
}

/** Re-exported for tests + runtime helpers. */
export { SERVICE_TYPE as N8N_RUNTIME_CONTEXT_PROVIDER_SERVICE_TYPE };

/**
 * Render a trigger-source fact line the LLM can read as part of the
 * `## Runtime Facts` block. Returns `undefined` when the trigger context
 * is empty / has no actionable platform routing info.
 */
function formatTriggerContextFact(
  ctx: TriggerContext | undefined,
): string | undefined {
  if (!ctx) return undefined;
  const channelName = ctx.resolvedNames?.channel;
  const serverName = ctx.resolvedNames?.server;

  if (ctx.discord?.channelId) {
    const channelLabel = channelName ? `#${channelName}` : "the channel";
    const serverPart = ctx.discord.guildId
      ? serverName
        ? ` within "${serverName}" (id ${ctx.discord.guildId})`
        : ` within guild id ${ctx.discord.guildId}`
      : "";
    return `This workflow was prompted from a Discord conversation in ${channelLabel} (id ${ctx.discord.channelId})${serverPart}. When the user references "this channel" or "back to here", target that channel ID.`;
  }
  if (ctx.telegram?.chatId !== undefined) {
    return `This workflow was prompted from a Telegram chat (id ${ctx.telegram.chatId}). When the user references "this chat" or "back to here", target that chat ID.`;
  }
  if (ctx.slack?.channelId) {
    const teamPart = ctx.slack.teamId ? ` in team ${ctx.slack.teamId}` : "";
    return `This workflow was prompted from a Slack channel (id ${ctx.slack.channelId})${teamPart}. When the user references "this channel" or "back to here", target that channel ID.`;
  }
  if (ctx.source) {
    return `This workflow was prompted from a ${ctx.source} conversation.`;
  }
  return undefined;
}

export function startElizaN8nRuntimeContextProvider(
  runtime: AgentRuntime,
  options: ElizaN8nRuntimeContextProviderOptions,
): ElizaN8nRuntimeContextProviderHandle {
  const { getConfig, credProvider } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  // Per-token Discord cache. Discord guilds + channels rarely change; a
  // 5-minute window is plenty for dogfood and avoids hammering REST during a
  // generate→modify regeneration burst. Shared with the catalog service when
  // the host wires both off the same instance.
  const discordCache: DiscordSourceCache =
    options.discordCache ?? createDiscordSourceCache();

  /**
   * Enumerate the Discord bot's guilds and text channels via the shared
   * source, then format the structured result as the LLM-facing fact lines.
   */
  const fetchDiscordFacts = async (botToken: string): Promise<string[]> => {
    const enumeration = await fetchDiscordEnumeration(botToken, {
      fetchImpl,
      now,
      cache: discordCache,
      logger: { warn: runtime.logger.warn?.bind(runtime.logger) },
    });
    return formatDiscordEnumerationAsFacts(enumeration);
  };

  /**
   * Filter the static CRED_TYPE_FACTS to types that are (a) listed in
   * ELIZA_SUPPORTED_CRED_TYPES, (b) appear in the requested
   * `relevantCredTypes` (so we only advertise types the LLM might actually
   * use), and (c) the cred provider can satisfy with `credential_data`
   * (so we don't promise a credential the user hasn't wired up yet).
   */
  const computeSupportedCredentials = async (
    userId: string,
    relevantCredTypes: string[],
  ): Promise<RuntimeContextSupportedCredential[]> => {
    const out: RuntimeContextSupportedCredential[] = [];
    for (const credType of relevantCredTypes) {
      if (!ELIZA_SUPPORTED_CRED_TYPES.has(credType)) continue;
      const meta = CRED_TYPE_FACTS[credType];
      if (!meta) continue;
      if (credProvider) {
        try {
          const result = await credProvider.resolve(userId, credType);
          if (!result || result.status !== "credential_data") continue;
        } catch (err) {
          runtime.logger.warn?.(
            {
              src: "n8n-runtime-context-provider",
              credType,
              err: err instanceof Error ? err.message : String(err),
            },
            "credential provider resolve() threw — skipping cred type",
          );
          continue;
        }
      }
      out.push({
        credType,
        friendlyName: meta.friendlyName,
        nodeTypes: meta.nodeTypes,
      });
    }
    return out;
  };

  const getRuntimeContext = async (
    input: RuntimeContextProviderInput,
  ): Promise<RuntimeContext> => {
    const config = getConfig();
    const connectors = config.connectors ?? {};

    const supportedCredentials = await computeSupportedCredentials(
      input.userId,
      input.relevantCredTypes,
    );

    const facts: string[] = [];

    // Discord facts — only emit when at least one relevant node uses Discord.
    const wantsDiscord = input.relevantNodes.some((n) =>
      n.name.startsWith("n8n-nodes-base.discord"),
    );
    if (wantsDiscord) {
      const token = connectors.discord?.token?.trim();
      if (token) {
        const discordFacts = await fetchDiscordFacts(token);
        for (const f of discordFacts) facts.push(f);
      }
    }

    // Gmail facts — only when a Gmail node is in scope.
    const wantsGmail = input.relevantNodes.some((n) =>
      n.name.startsWith("n8n-nodes-base.gmail"),
    );
    if (wantsGmail) {
      const email = connectors.gmail?.email?.trim();
      if (email) {
        facts.push(`Connected Gmail account: ${email}.`);
      }
    }

    // Originating-conversation routing fact. Surfaced regardless of which
    // nodes are in scope — the user might say "post the result back here"
    // and the relevant node search has no way to anchor that intent.
    const triggerFact = formatTriggerContextFact(input.triggerContext);
    if (triggerFact) {
      facts.push(triggerFact);
    }

    return { supportedCredentials, facts };
  };

  const service = {
    getRuntimeContext,
    stop: async () => {
      discordCache.clear();
    },
    capabilityDescription:
      "Provides Eliza runtime facts (Discord guilds/channels, Gmail email) and supported credential types to the n8n workflow generator.",
  };

  runtime.services.set(SERVICE_TYPE as never, [service as never]);

  return {
    service,
    stop: () => {
      try {
        runtime.services.delete(SERVICE_TYPE as never);
      } catch {
        // ignore — symmetric with other Eliza bridge stop hooks
      }
    },
  };
}
