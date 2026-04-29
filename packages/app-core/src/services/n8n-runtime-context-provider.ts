/**
 * Milady n8n runtime-context provider — registers as service type
 * `n8n_runtime_context_provider` so the patched `@elizaos/plugin-n8n-workflow`
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

const SERVICE_TYPE = "n8n_runtime_context_provider";

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
const MILADY_SUPPORTED_CRED_TYPES: ReadonlySet<string> = new Set([
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

interface RuntimeContextProviderInput {
  userId: string;
  relevantNodes: PluginNodeDefinition[];
  relevantCredTypes: string[];
}

/**
 * Static map: which n8n cred types match which n8n node types, plus a
 * human-friendly name for the credential block. Filtered at runtime against
 * `MILADY_SUPPORTED_CRED_TYPES` AND against which connectors are actually
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
    nodeTypes: [
      "n8n-nodes-base.telegram",
      "n8n-nodes-base.telegramTrigger",
    ],
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

/** Cache TTL for upstream REST lookups (Discord guilds/channels). */
const FACT_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedFacts {
  expiresAt: number;
  facts: string[];
}

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

export interface MiladyN8nRuntimeContextProviderOptions {
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
}

export interface MiladyN8nRuntimeContextProviderHandle {
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

export function startMiladyN8nRuntimeContextProvider(
  runtime: AgentRuntime,
  options: MiladyN8nRuntimeContextProviderOptions,
): MiladyN8nRuntimeContextProviderHandle {
  const { getConfig, credProvider } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  // Per-token Discord cache. Discord guilds + channels rarely change; a
  // 5-minute window is plenty for dogfood and avoids hammering REST during a
  // generate→modify regeneration burst.
  const discordCache = new Map<string, CachedFacts>();

  /**
   * Enumerate the Discord bot's guilds and (text) channels. Returns one
   * compact fact line per guild. Network failures degrade to an empty array.
   */
  const fetchDiscordFacts = async (botToken: string): Promise<string[]> => {
    const cached = discordCache.get(botToken);
    if (cached && cached.expiresAt > now()) {
      return cached.facts;
    }
    try {
      const headers = { Authorization: `Bot ${botToken}` };
      const guildsRes = await fetchImpl(
        "https://discord.com/api/v10/users/@me/guilds",
        { headers },
      );
      if (!guildsRes.ok) {
        runtime.logger.warn?.(
          {
            src: "n8n-runtime-context-provider",
            status: guildsRes.status,
          },
          "Discord guilds REST returned non-ok",
        );
        const facts: string[] = [];
        discordCache.set(botToken, {
          expiresAt: now() + FACT_CACHE_TTL_MS,
          facts,
        });
        return facts;
      }
      const guilds = (await guildsRes.json()) as Array<{
        id: string;
        name: string;
      }>;
      const facts: string[] = [];
      for (const guild of guilds) {
        try {
          const channelsRes = await fetchImpl(
            `https://discord.com/api/v10/guilds/${guild.id}/channels`,
            { headers },
          );
          if (!channelsRes.ok) {
            facts.push(
              `Discord guild "${guild.name}" (id ${guild.id}) — channels not enumerable (status ${channelsRes.status}).`,
            );
            continue;
          }
          const channels = (await channelsRes.json()) as Array<{
            id: string;
            name: string;
            type: number;
          }>;
          // type === 0 is GUILD_TEXT, the only kind n8n's Discord node posts to.
          const textChannels = channels
            .filter((c) => c.type === 0)
            .map((c) => `#${c.name} (${c.id})`)
            .join(", ");
          facts.push(
            textChannels.length > 0
              ? `Discord guild "${guild.name}" (id ${guild.id}) channels: ${textChannels}.`
              : `Discord guild "${guild.name}" (id ${guild.id}) — no text channels visible to the bot.`,
          );
        } catch (err) {
          runtime.logger.warn?.(
            {
              src: "n8n-runtime-context-provider",
              guildId: guild.id,
              err: err instanceof Error ? err.message : String(err),
            },
            "Discord channels REST threw",
          );
        }
      }
      discordCache.set(botToken, {
        expiresAt: now() + FACT_CACHE_TTL_MS,
        facts,
      });
      return facts;
    } catch (err) {
      runtime.logger.warn?.(
        {
          src: "n8n-runtime-context-provider",
          err: err instanceof Error ? err.message : String(err),
        },
        "Discord guilds REST threw",
      );
      return [];
    }
  };

  /**
   * Filter the static CRED_TYPE_FACTS to types that are (a) listed in
   * MILADY_SUPPORTED_CRED_TYPES, (b) appear in the requested
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
      if (!MILADY_SUPPORTED_CRED_TYPES.has(credType)) continue;
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

    return { supportedCredentials, facts };
  };

  const service = {
    getRuntimeContext,
    stop: async () => {
      discordCache.clear();
    },
    capabilityDescription:
      "Provides Milady runtime facts (Discord guilds/channels, Gmail email) and supported credential types to the n8n workflow generator.",
  };

  runtime.services.set(SERVICE_TYPE as never, [service as never]);

  return {
    service,
    stop: () => {
      try {
        runtime.services.delete(SERVICE_TYPE as never);
      } catch {
        // ignore — symmetric with other Milady bridge stop hooks
      }
    },
  };
}
