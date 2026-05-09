import { client } from "../../api";
import type {
  Conversation,
  ConversationMetadata,
} from "../../api/client-types-chat";

export type PageScope =
  | "page-browser"
  | "page-character"
  | "page-automations"
  | "page-apps"
  | "page-connectors"
  | "page-phone"
  | "page-plugins"
  | "page-lifeops"
  | "page-settings"
  | "page-wallet";

export const PAGE_SCOPES: readonly PageScope[] = [
  "page-browser",
  "page-character",
  "page-automations",
  "page-apps",
  "page-connectors",
  "page-phone",
  "page-plugins",
  "page-lifeops",
  "page-settings",
  "page-wallet",
] as const;

const PAGE_SCOPE_ROUTING_CONTEXTS: Record<
  PageScope,
  { primaryContext: string; secondaryContexts: string[] }
> = {
  "page-browser": {
    primaryContext: "browser",
    secondaryContexts: ["page", "page-browser", "browser", "documents"],
  },
  "page-character": {
    primaryContext: "character",
    secondaryContexts: [
      "page",
      "page-character",
      "character",
      "documents",
      "social_posting",
    ],
  },
  "page-automations": {
    primaryContext: "automation",
    secondaryContexts: ["page", "page-automations", "automation"],
  },
  "page-apps": {
    primaryContext: "apps",
    secondaryContexts: ["page", "page-apps", "apps"],
  },
  "page-connectors": {
    primaryContext: "connectors",
    secondaryContexts: [
      "page",
      "page-connectors",
      "connectors",
      "social_posting",
    ],
  },
  "page-phone": {
    primaryContext: "phone",
    secondaryContexts: ["page", "page-phone", "phone", "social_posting"],
  },
  "page-plugins": {
    primaryContext: "plugins",
    secondaryContexts: ["page", "page-plugins", "plugins", "admin"],
  },
  "page-lifeops": {
    primaryContext: "lifeops",
    secondaryContexts: [
      "page",
      "page-lifeops",
      "lifeops",
      "automation",
      "social_posting",
    ],
  },
  "page-settings": {
    primaryContext: "settings",
    secondaryContexts: ["page", "page-settings", "settings", "admin"],
  },
  "page-wallet": {
    primaryContext: "wallet",
    secondaryContexts: ["page", "page-wallet", "wallet"],
  },
};

/**
 * Bump when the per-scope brief, intro copy, or live-state shape changes
 * meaningfully — so a future MIPRO/GEPA optimization pass can filter to a
 * single prompt-regime cohort instead of mixing trajectories generated under
 * different surface contracts.
 */
export const PAGE_SCOPE_VERSION = 13;

export interface PageScopeIntroCopy {
  /** Short user-facing intro card title shown when the conversation is empty. */
  title: string;
  /** Body shown to the user before they type. */
  body: string;
  /**
   * System prompt addendum prepended to the FIRST user turn so the agent is
   * grounded in the surface from message #1. Distinct from the user-facing
   * intro and never persisted as a visible message.
   */
  systemAddendum: string;
}

export const PAGE_SCOPE_COPY: Record<PageScope, PageScopeIntroCopy> = {
  "page-browser": {
    title: "Browser chat",
    body: "Use me to drive the browser while you watch. I narrate each step here as a short status line; you confirm transactions in the wallet sheet. User Tabs are writable; Agent Tabs and App Tabs are read-only context.",
    systemAddendum:
      "You are answering inside the Browser view in watch mode: the user is watching a visible cursor move and the browser tab paint live as you work. Tabs are grouped into User Tabs, Agent Tabs, and App Tabs. You may mutate User Tabs: open them, navigate them, refresh them, snapshot them, show or hide them, and close them. Agent Tabs and App Tabs are read-only context — never navigate, click, type into, refresh, close, or otherwise mutate them. When you take a browser action, recommend and prefer the realistic-* BROWSER subactions (realistic-click, realistic-fill, realistic-type, realistic-press) with watchMode:true so the cursor moves visibly and pointer/keyboard events fire faithfully on React-controlled inputs. Emit a short status line in chat BEFORE each concrete action — for example 'Navigating to four.meme', 'Choosing token name: $WAGMI', 'Filling description', 'Submitting — please confirm in your wallet'. Keep narration to one line per step. Never auto-sign transactions; the user confirms each one in the wallet approval sheet. Ground every answer in the live tab list provided in context. Never invent tabs or URLs.",
  },
  "page-character": {
    title: "Character chat",
    body: "Use me to work with the Character hub. I can help you review Overview, refine Personality, manage Knowledge, inspect Skills, inspect Experience, and explore Relationships. Recommended: tell me what you want to change or understand, and I'll point to the right section or draft exact copy. Ask me what to update next.",
    systemAddendum:
      "You are answering inside the Character view. The Character hub is organized into Overview, Personality, Knowledge, Skills, Experience, and Relationships. Help the user navigate those sections, recommend the next character step from live state, and draft exact wording when they need copy. Use Overview for high-level status and identity framing, Personality for editable persona/voice fields, Knowledge for uploaded reference material, Skills for learned skill proposals and status, Experience for surfaced learnings, and Relationships for contact and graph context. Guide the user to the relevant section instead of inventing a generic setter action. Reference live character state when answering.",
  },
  "page-automations": {
    title: "Automations",
    body: "Use me to create or inspect a task or n8n workflow. Tell me the trigger, timing, and result.",
    systemAddendum:
      'You are answering inside the Automations view. The user can create tasks and n8n workflows, attach either one to a schedule or event, configure wake mode, max runs, and enabled state, browse templates, inspect existing automations, and troubleshoot failed runs. Treat tasks as simple prompt-driven automations and workflows as multi-step n8n pipelines. Recommend the smaller task shape unless the user clearly needs a multi-step pipeline. When the user describes a concrete automation, dispatch it via the planner actions field: TRIGGER (op="create") for scheduled or event tasks, WORKFLOW (op="create") for n8n workflows, or TASK (op="list"|"create"|"update"|"complete"|"delete") for task list operations. Reference live tasks and workflows in context by display name. Never fabricate automation names.',
  },
  "page-apps": {
    title: "Apps chat",
    body: "Use me to browse the catalog, compare apps, launch an app, stop a running app, open a live viewer, inspect run health, and manage favorites or recent apps. Recommended: describe the outcome you want, and I'll suggest the right app or launch it. Ask me about any catalog item or running app.",
    systemAddendum:
      "You are answering inside the Apps view. The user can browse the catalog, compare apps by category and capability, launch apps, stop running apps, open attached live viewers, inspect run health and summaries, and manage favorites or recent apps. Recommend the best app or next run-management action based on live catalog and run state. Use APP with mode launch, relaunch, list, load_from_directory, or create when the request is concrete. Refer to apps by display name and never invent app names.",
  },
  "page-connectors": {
    title: "Connectors chat",
    body: "Use me to inspect connector readiness, setup steps, auth state, and integration health. Recommended: ask what to connect or troubleshoot.",
    systemAddendum:
      "You are answering inside the Connectors view. The user can inspect connector availability, authentication state, setup requirements, and integration health. Recommend the smallest connector action that fits the user's goal, reference visible connector state when present, and never invent connected accounts, permissions, webhook state, or delivery results.",
  },
  "page-phone": {
    title: "Phone chat",
    body: "Use me to review calls, SMS, contacts, imported vCards, caller context, and transcript notes. Recommended: ask me to draft a reply, summarize a call, decide who to call back, or organize a contact from the phone workspace. Ask me what to do with any visible call or message.",
    systemAddendum:
      "You are answering inside the Android Phone view. The user can place calls through Android Telecom, open the dialer, send SMS through Android SMS, review recent calls, browse contacts, import vCards, and save call transcripts or summaries. Recommend the smallest concrete phone action that fits the user's goal. For calls or SMS, confirm the target number/contact and message content before sending. When discussing calls, messages, contacts, or transcripts, ground the answer in visible phone surface state when present and never invent call logs, contacts, message bodies, transcripts, or delivery results.",
  },
  "page-plugins": {
    title: "Plugins chat",
    body: "Use me to inspect installed plugins, configuration gaps, registry options, and runtime plugin health.",
    systemAddendum:
      "You are answering inside the Plugins view. The user can inspect installed plugins, registry plugins, configuration readiness, plugin health, and runtime capability gaps. Recommend the smallest plugin setup or troubleshooting action that fits the user's goal, reference visible plugin state when present, and never invent installed plugins, credentials, or enabled capabilities.",
  },
  "page-lifeops": {
    title: "LifeOps chat",
    body: "Ask me about the visible LifeOps item or the next action you want handled.",
    systemAddendum:
      "You are answering inside the LifeOps view. The user can inspect the current overview, goals, reminders, calendar, messages, mail, sleep, screen time, social context, connector setup, capability readiness, and LifeOps settings. Recommend capability readiness and overview review before creating or changing durable personal workflows. When the user asks for concrete LifeOps work, route through the LifeOps app actions/providers already available in the runtime instead of generic advice. Reference live LifeOps state when present, and never invent reminders, goals, messages, calendar events, or connector state.",
  },
  "page-settings": {
    title: "Settings chat",
    body: "Use me to tune models, providers, permissions, connectors, wallet RPC, cloud account state, appearance, updates, and feature toggles. Recommended: describe the capability you want to enable or troubleshoot, and I'll point to the right section or explain the tradeoffs.",
    systemAddendum:
      "You are answering inside the Settings view. The user can change cloud account state, AI models and providers, permissions, wallet RPC providers, feature toggles, appearance, updates, and connector-related configuration. Recommend the smallest concrete settings change that fits the user's goal and reference the visible section when possible. Ask follow-up questions when a setting affects security, spending, or external accounts. Never invent provider status, account state, or permission grants.",
  },
  "page-wallet": {
    title: "Wallet chat",
    body: "Use me to inspect token inventory, NFTs, LP positions, balances, P&L, activity, EVM/Solana addresses, RPC readiness, native Hyperliquid/Polymarket readiness, and Vincent delegated trading. Recommended: ask me to prepare a swap, bridge, market review, or delegated trading plan with the amount and constraints you want.",
    systemAddendum:
      "You are answering inside the Wallet view. The user can inspect token inventory, NFTs, LP positions, current balance, P&L, activity, EVM/Solana addresses, RPC/provider readiness, wallet/RPC settings, native Hyperliquid and Polymarket readiness, and Vincent delegated trading. There are no chain filters in this surface. Recommend the smallest concrete wallet action that fits the user's goal. For swaps, bridges, transfers, signatures, trading actions, or prediction-market actions, confirm the asset/market, amount, destination/outcome, slippage/risk limits, and execution path before invoking available wallet actions. If the user asks about Hyperliquid or Polymarket, prefer the native app surfaces for reads/status and only surface Vincent for delegated automated trading. Never invent balances, positions, fills, markets, odds, or execution support.",
  },
};

export const PAGE_SCOPE_DEFAULT_TITLE: Record<PageScope, string> = {
  "page-browser": "Browser",
  "page-character": "Character",
  "page-automations": "Automations",
  "page-apps": "Apps",
  "page-connectors": "Connectors",
  "page-phone": "Phone",
  "page-plugins": "Plugins",
  "page-lifeops": "LifeOps",
  "page-settings": "Settings",
  "page-wallet": "Wallet",
};

/**
 * Browser scope intro copy varies by Agent Browser Bridge companion state: when the
 * extension is connected the agent can drive real tabs; when it isn't the
 * intro has to walk the user through installing the extension instead of
 * pretending real-browser control is available.
 */
export function getBrowserPageScopeCopy(state: {
  browserBridgeConnected: boolean;
  browserBridgeInstallAvailable?: boolean;
  browserLabel?: string | null;
  profileLabel?: string | null;
}): PageScopeIntroCopy {
  if (state.browserBridgeConnected) {
    const browser = state.browserLabel?.trim() || "Chrome";
    const profile = state.profileLabel?.trim();
    const where = profile ? `${browser} / ${profile}` : browser;
    return {
      title: "Browser chat",
      body: `Agent Browser Bridge is connected in ${where}. User Tabs are writable; Agent Tabs and App Tabs are read-only context. Use me to open, navigate, refresh, snapshot, show, hide, or close User Tabs and explain what is currently open in any tab.`,
      systemAddendum: `You are answering inside the Browser view. Agent Browser Bridge is connected in ${where}. Tabs are grouped into User Tabs, Agent Tabs, and App Tabs. You may mutate User Tabs: open them, navigate them, refresh them, snapshot them, show or hide them, and close them. Agent Tabs and App Tabs are read-only context: you may inspect, summarize, or reference them, but do not navigate, click, type into, refresh, close, or otherwise mutate them. Recommend the next browser action based on the live tab list. Ground every answer in the live tab list provided in context. Never invent tabs or URLs.`,
    };
  }
  if (state.browserBridgeInstallAvailable === false) {
    return {
      title: "Browser chat",
      body: "Use me with the embedded browser in this view. User Tabs are writable; Agent Tabs and App Tabs are read-only context. Real Chrome control is unavailable in the current runtime, so I can help with embedded User Tabs, navigation, forms, and page questions only.",
      systemAddendum:
        "You are answering inside the Browser view. Agent Browser Bridge is not available in this runtime, so real Chrome control cannot be enabled from this session. Tabs are grouped into User Tabs, Agent Tabs, and App Tabs. You may mutate embedded User Tabs only. Agent Tabs and App Tabs remain read-only context. Help the user with the embedded browser only: opening User Tabs, navigating URLs, refreshing pages, and answering questions about the current embedded page or tab list. Do not recommend installing Agent Browser Bridge or promise real-browser tab control.",
    };
  }
  return {
    title: "Install Agent Browser Bridge",
    body: "Install Agent Browser Bridge so I can drive real Chrome tabs. User Tabs are writable; Agent Tabs and App Tabs are read-only context. Until it connects, I can still help with the embedded browser.",
    systemAddendum:
      "You are answering inside the Browser view. The user has NOT installed the Agent Browser Bridge companion extension yet. Tabs are grouped into User Tabs, Agent Tabs, and App Tabs. You may mutate embedded User Tabs only. Agent Tabs and App Tabs are read-only context. Guide them to click the Install Agent Browser Bridge button visible in this chat panel — it builds the extension and opens Chrome's extension manager so they can load the unpacked folder. Recommend connecting the extension before requests that need real Chrome control. Until the extension is connected, only the embedded iframe browser is available; do not invent real-browser tabs or promise real-tab control. Offer to answer setup questions or help with embedded browsing.",
  };
}

export function isPageScopedConversation(
  conversation: Pick<Conversation, "metadata"> | null | undefined,
): boolean {
  const scope = conversation?.metadata?.scope;
  return typeof scope === "string" && scope.startsWith("page-");
}

export function isPageScopedConversationMetadata(
  metadata: ConversationMetadata | null | undefined,
): boolean {
  const scope = metadata?.scope;
  return typeof scope === "string" && scope.startsWith("page-");
}

export function buildPageScopedConversationMetadata(
  scope: PageScope,
  options: { sourceConversationId?: string; pageId?: string } = {},
): ConversationMetadata {
  const metadata: ConversationMetadata = { scope };
  if (options.pageId) {
    metadata.pageId = options.pageId;
  }
  if (options.sourceConversationId) {
    metadata.sourceConversationId = options.sourceConversationId;
  }
  return metadata;
}

/**
 * Routing metadata stamped on every page-scope send. The runtime persists this
 * into the trajectory `metadata` column verbatim — every field here is a
 * sortable dimension for later analysis or per-scope prompt optimization.
 */
export function buildPageScopedRoutingMetadata(
  scope: PageScope,
  options: { sourceConversationId?: string; pageId?: string } = {},
): Record<string, unknown> {
  const routing = PAGE_SCOPE_ROUTING_CONTEXTS[scope];
  const metadata: Record<string, unknown> = {
    __responseContext: {
      primaryContext: routing.primaryContext,
      secondaryContexts: routing.secondaryContexts,
    },
    taskId: scope,
    surface: "page-scoped",
    surfaceVersion: PAGE_SCOPE_VERSION,
  };
  if (options.pageId) {
    metadata.pageId = options.pageId;
  }
  if (options.sourceConversationId) {
    metadata.sourceConversationId = options.sourceConversationId;
  }
  return metadata;
}

function findPageScopedConversation(
  conversations: Conversation[],
  scope: PageScope,
  pageId?: string,
): Conversation | null {
  const matching = conversations.filter(
    (conversation) =>
      conversation.metadata?.scope === scope &&
      (conversation.metadata?.pageId ?? undefined) === (pageId ?? undefined),
  );
  if (matching.length === 0) return null;
  return matching.sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  )[0];
}

function findPageScopedConversations(
  conversations: Conversation[],
  scope: PageScope,
  pageId?: string,
): Conversation[] {
  return conversations
    .filter(
      (conversation) =>
        conversation.metadata?.scope === scope &&
        (conversation.metadata?.pageId ?? undefined) === (pageId ?? undefined),
    )
    .sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() -
        new Date(left.updatedAt).getTime(),
    );
}

export async function resolvePageScopedConversation(params: {
  scope: PageScope;
  title?: string;
  pageId?: string;
}): Promise<Conversation> {
  const { scope, pageId } = params;
  const title = params.title?.trim() || PAGE_SCOPE_DEFAULT_TITLE[scope];
  const desiredMetadata = buildPageScopedConversationMetadata(scope, {
    pageId,
  });

  const { conversations } = await client.listConversations();
  const existing = findPageScopedConversation(conversations, scope, pageId);

  if (existing) {
    const titleMatches = existing.title === title;
    const metadataMatches =
      existing.metadata?.scope === scope &&
      (existing.metadata?.pageId ?? undefined) === (pageId ?? undefined);
    if (titleMatches && metadataMatches) {
      return existing;
    }
    const { conversation } = await client.updateConversation(existing.id, {
      title,
      metadata: desiredMetadata,
    });
    return conversation;
  }

  const { conversation } = await client.createConversation(title, {
    metadata: desiredMetadata,
  });
  return conversation;
}

export async function resetPageScopedConversation(params: {
  scope: PageScope;
  title?: string;
  pageId?: string;
}): Promise<Conversation> {
  const { scope, pageId } = params;
  const title = params.title?.trim() || PAGE_SCOPE_DEFAULT_TITLE[scope];
  const desiredMetadata = buildPageScopedConversationMetadata(scope, {
    pageId,
  });

  const { conversations } = await client.listConversations();
  const matching = findPageScopedConversations(conversations, scope, pageId);

  if (matching.length > 0) {
    await Promise.allSettled(
      matching.map((conversation) =>
        client.deleteConversation(conversation.id),
      ),
    );
  }

  const { conversation } = await client.createConversation(title, {
    metadata: desiredMetadata,
  });
  return conversation;
}
