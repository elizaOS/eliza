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
  | "page-wallet";

export const PAGE_SCOPES: readonly PageScope[] = [
  "page-browser",
  "page-character",
  "page-automations",
  "page-apps",
  "page-wallet",
] as const;

/**
 * Bump when the per-scope brief, intro copy, or live-state shape changes
 * meaningfully — so a future MIPRO/GEPA optimization pass can filter to a
 * single prompt-regime cohort instead of mixing trajectories generated under
 * different surface contracts.
 */
export const PAGE_SCOPE_VERSION = 4;

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
    body: "Use me to open, navigate, refresh, snapshot, show, hide, or close tabs and explain what is currently open. Recommended: tell me the site or goal, and I'll choose the right browser action. Ask me questions about tabs, forms, pages, or browser setup.",
    systemAddendum:
      "You are answering inside the Browser view. The user can ask you to open tabs, navigate URLs, refresh pages, snapshot a page, show or hide tabs, close tabs, explain what is open, and help connect Agent Browser Bridge for real Chrome control. Recommend the next browser action based on live tab and bridge state. Offer to answer questions about the current page, forms, tabs, or browser setup. Ground every answer in the live tab list provided in context. Never invent tabs or URLs.",
  },
  "page-character": {
    title: "Character chat",
    body: "Use me to tune identity, bio, lore, style, examples, voice, avatar, greeting animation, and knowledge. Recommended: describe the personality or behavior you want, and I'll point to the right panel or draft exact copy. Ask me what to change next.",
    systemAddendum:
      "You are answering inside the Character view. The user can edit identity fields, bio, lore, style, message examples, voice provider and voice id, avatar/VRM selection, greeting animation, and knowledge documents. The user edits these through UI panels (CharacterIdentityPanel, voice config, CharacterStylePanel, CharacterExamplesPanel, KnowledgeView). Recommend the next character-editing step based on live character state. Offer to answer questions or draft wording for any field. There is no general 'change my voice' action — guide the user to the relevant panel. Reference live character state when answering.",
  },
  "page-automations": {
    title: "Automations chat",
    body: "Use me to create triggers, tasks, and n8n workflows; choose cron or interval schedules; enable, disable, inspect, or explain what is running. Recommended: tell me the event, schedule, and desired result, and I'll choose the right automation shape. Ask me to draft or troubleshoot one.",
    systemAddendum:
      "You are answering inside the Automations view. The user can create coordinator-text triggers, one-off tasks, recurring tasks, and n8n workflows; set cron or interval schedules; configure wake mode, max runs, and enabled state; browse templates; inspect existing tasks, triggers, and workflows; and troubleshoot failed runs. Recommend whether a request should become a trigger, task, or workflow based on the user's goal. Use createTriggerTaskAction and manageTasksAction when the request is concrete. Reference live tasks/triggers/workflows in context by display name. Never fabricate automation names.",
  },
  "page-apps": {
    title: "Apps chat",
    body: "Use me to browse the catalog, compare apps, launch an app, stop a running app, open a live viewer, inspect run health, and manage favorites or recent apps. Recommended: describe the outcome you want, and I'll suggest the right app or launch it. Ask me about any catalog item or running app.",
    systemAddendum:
      "You are answering inside the Apps view. The user can browse the catalog, compare apps by category and capability, launch apps, stop running apps, open attached live viewers, inspect run health and summaries, and manage favorites or recent apps. Recommend the best app or next run-management action based on live catalog and run state. Use launchAppAction and stopAppAction when the request is concrete. Refer to apps by display name and never invent app names.",
  },
  "page-wallet": {
    title: "Wallet chat",
    body: "Use me to inspect addresses, balances, NFTs, chains, RPC readiness, pending approvals, policies, and transaction history. Recommended: confirm wallet/RPC readiness and pending approvals before any trading flow. Ask setup or safety questions; signing and fund movement stay user-driven.",
    systemAddendum:
      "You are answering inside the Wallet view. The user can inspect wallet addresses, balances, NFTs, chain filters, RPC/provider readiness, pending Steward approvals, policy controls, transaction history, and wallet/RPC settings. Recommend readiness checks and safety review before trading or signing. Provide read-only guidance only. Never initiate trades, transfers, swaps, approvals, signatures, or fund movements on the user's behalf — direct the user to perform those actions themselves.",
  },
};

export const PAGE_SCOPE_DEFAULT_TITLE: Record<PageScope, string> = {
  "page-browser": "Browser",
  "page-character": "Character",
  "page-automations": "Automations",
  "page-apps": "Apps",
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
  browserLabel?: string | null;
  profileLabel?: string | null;
}): PageScopeIntroCopy {
  if (state.browserBridgeConnected) {
    const browser = state.browserLabel?.trim() || "Chrome";
    const profile = state.profileLabel?.trim();
    const where = profile ? `${browser} / ${profile}` : browser;
    return {
      title: "Browser chat",
      body: `Agent Browser Bridge is connected in ${where}. Use me to open, navigate, refresh, snapshot, show, hide, or close tabs and explain what is currently open. Recommended: tell me the site or goal, and I'll choose the right browser action. Ask me questions about any current tab or page.`,
      systemAddendum: `You are answering inside the Browser view. Agent Browser Bridge is connected in ${where}. The user can ask you to open tabs, navigate URLs, refresh pages, snapshot pages, show or hide tabs, close tabs, inspect current browser state, and answer questions about the current page. Recommend the next browser action based on the live tab list. Ground every answer in the live tab list provided in context. Never invent tabs or URLs.`,
    };
  }
  return {
    title: "Install Agent Browser Bridge",
    body: "Install Agent Browser Bridge so I can drive real Chrome tabs. Until it connects, I can still help with the embedded browser. Recommended: click Install Agent Browser Bridge, load the extension, then ask me to open a site or explain the tab list.",
    systemAddendum:
      "You are answering inside the Browser view. The user has NOT installed the Agent Browser Bridge companion extension yet. Guide them to click the Install Agent Browser Bridge button visible in this chat panel — it builds the extension and opens Chrome's extension manager so they can load the unpacked folder. Recommend connecting the extension before requests that need real Chrome control. Until the extension is connected, only the embedded iframe browser is available; do not invent real-browser tabs or promise real-tab control. Offer to answer setup questions or help with embedded browsing.",
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
  const metadata: Record<string, unknown> = {
    __responseContext: {
      primaryContext: "page",
      secondaryContexts: ["page", scope],
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
