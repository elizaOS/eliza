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
export const PAGE_SCOPE_VERSION = 3;

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
    body: "Ask me to open a tab, navigate somewhere, snapshot a page, or close a tab. I can also explain what's currently open.",
    systemAddendum:
      "You are answering inside the Browser view. The user can ask you to open tabs, navigate, snapshot, show/hide, or close tabs in the embedded browser companion. Ground every answer in the live tab list provided in context. Never invent tabs or URLs.",
  },
  "page-character": {
    title: "Character chat",
    body: "Ask me how to edit your name, bio, voice, examples, avatar, greeting animation, or knowledge. I'll point you to the panel that does it.",
    systemAddendum:
      "You are answering inside the Character view. The user edits identity, voice, style, and message examples through UI panels (CharacterIdentityPanel, voice config, CharacterStylePanel, CharacterExamplesPanel, KnowledgeView). There is no general 'change my voice' action — guide the user to the relevant panel. Reference live character state when answering.",
  },
  "page-automations": {
    title: "Automations chat",
    body: "Ask me to create a trigger or workflow, set a cron or interval schedule, enable or disable an automation, or explain what's already running.",
    systemAddendum:
      "You are answering inside the Automations view. The user can create coordinator-text triggers and n8n workflows with cron/interval schedules. Use createTriggerTaskAction and manageTasksAction when the request is concrete. Reference live tasks/triggers in context by display name. Never fabricate trigger names.",
  },
  "page-apps": {
    title: "Apps chat",
    body: "Ask me about apps in the catalog, launch one, stop a running app, or check on running app instances.",
    systemAddendum:
      "You are answering inside the Apps view. The user browses the catalog, launches apps, stops running apps, and views running app health. Use launchAppAction and stopAppAction when the request is concrete. Refer to apps by display name and never invent app names.",
  },
  "page-wallet": {
    title: "Wallet chat",
    body: "Ask me to read your wallet state. Wallet operations are user-driven — I won't initiate trades, transfers, or fund movements.",
    systemAddendum:
      "You are answering inside the Wallet view. Provide read-only guidance only. Never initiate trades, transfers, or fund movements on the user's behalf — always direct the user to perform those actions themselves.",
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
      body: `Agent Browser Bridge is connected in ${where}. Ask me to open a tab, navigate somewhere, snapshot a page, or close a tab. I can also explain what's currently open.`,
      systemAddendum: `You are answering inside the Browser view. Agent Browser Bridge is connected in ${where}. The user can ask you to open tabs, navigate, snapshot, show/hide, or close tabs in the connected browser companion. Ground every answer in the live tab list provided in context. Never invent tabs or URLs.`,
    };
  }
  return {
    title: "Install Agent Browser Bridge",
    body: "The agent can drive your real Chrome tabs once you install the Agent Browser Bridge extension. Use the buttons below to build the extension and open Chrome's extension manager, then come back and I'll work against your real browser.",
    systemAddendum:
      "You are answering inside the Browser view. The user has NOT installed the Agent Browser Bridge companion extension yet. Guide them to click the Install Agent Browser Bridge button visible in this chat panel — it builds the extension and opens Chrome's extension manager so they can load the unpacked folder. Until the extension is connected, only the embedded iframe browser is available; do not invent real-browser tabs or promise real-tab control.",
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
