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
export declare const PAGE_SCOPES: readonly PageScope[];
/**
 * Bump when the per-scope brief, intro copy, or live-state shape changes
 * meaningfully — so a future MIPRO/GEPA optimization pass can filter to a
 * single prompt-regime cohort instead of mixing trajectories generated under
 * different surface contracts.
 */
export declare const PAGE_SCOPE_VERSION = 13;
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
export declare const PAGE_SCOPE_COPY: Record<PageScope, PageScopeIntroCopy>;
export declare const PAGE_SCOPE_DEFAULT_TITLE: Record<PageScope, string>;
/**
 * Browser scope intro copy varies by Agent Browser Bridge companion state: when the
 * extension is connected the agent can drive real tabs; when it isn't the
 * intro has to walk the user through installing the extension instead of
 * pretending real-browser control is available.
 */
export declare function getBrowserPageScopeCopy(state: {
  browserBridgeConnected: boolean;
  browserBridgeInstallAvailable?: boolean;
  browserLabel?: string | null;
  profileLabel?: string | null;
}): PageScopeIntroCopy;
export declare function isPageScopedConversation(
  conversation: Pick<Conversation, "metadata"> | null | undefined,
): boolean;
export declare function isPageScopedConversationMetadata(
  metadata: ConversationMetadata | null | undefined,
): boolean;
export declare function buildPageScopedConversationMetadata(
  scope: PageScope,
  options?: {
    sourceConversationId?: string;
    pageId?: string;
  },
): ConversationMetadata;
/**
 * Routing metadata stamped on every page-scope send. The runtime persists this
 * into the trajectory `metadata` column verbatim — every field here is a
 * sortable dimension for later analysis or per-scope prompt optimization.
 */
export declare function buildPageScopedRoutingMetadata(
  scope: PageScope,
  options?: {
    sourceConversationId?: string;
    pageId?: string;
  },
): Record<string, unknown>;
export declare function resolvePageScopedConversation(params: {
  scope: PageScope;
  title?: string;
  pageId?: string;
}): Promise<Conversation>;
export declare function resetPageScopedConversation(params: {
  scope: PageScope;
  title?: string;
  pageId?: string;
}): Promise<Conversation>;
//# sourceMappingURL=page-scoped-conversations.d.ts.map
