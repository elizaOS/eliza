import { client } from "../../api";
import type {
  Conversation,
  ConversationMetadata,
} from "../../api/client-types-chat";

export type PageScope =
  | "page-character"
  | "page-apps"
  | "page-wallet"
  | "page-browser"
  | "page-automations";

const PAGE_SCOPES = new Set<string>([
  "page-character",
  "page-apps",
  "page-wallet",
  "page-browser",
  "page-automations",
]);

function sortByUpdatedAtDesc(left: Conversation, right: Conversation): number {
  return (
    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );
}

function trimOptionalString(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isPageScopeMetadata(
  metadata: ConversationMetadata | null | undefined,
): boolean {
  return metadata?.scope ? PAGE_SCOPES.has(metadata.scope) : false;
}

export function buildPageConversationMetadata(
  scope: PageScope,
  pageId?: string,
  bridgeConversationId?: string,
): ConversationMetadata {
  const trimmedPageId = trimOptionalString(pageId);
  const trimmedBridgeId = trimOptionalString(bridgeConversationId);
  return {
    scope,
    ...(trimmedPageId ? { pageId: trimmedPageId } : {}),
    ...(trimmedBridgeId
      ? {
          sourceConversationId: trimmedBridgeId,
          terminalBridgeConversationId: trimmedBridgeId,
        }
      : {}),
  };
}

export function buildPageResponseRoutingMetadata(
  metadata: ConversationMetadata,
): Record<string, unknown> {
  return {
    __responseContext: {
      primaryContext: "page",
      secondaryContexts: [metadata.scope ?? "page", "system"],
    },
  };
}

function pageIdentityForMetadata(
  metadata: ConversationMetadata | null | undefined,
): string | null {
  if (!metadata?.scope || !PAGE_SCOPES.has(metadata.scope)) {
    return null;
  }
  const pageId = trimOptionalString(metadata.pageId);
  return pageId ? `${metadata.scope}:${pageId}` : metadata.scope;
}

export function findPageScopedConversation(
  conversations: Conversation[],
  metadata: ConversationMetadata,
): Conversation | null {
  const targetIdentity = pageIdentityForMetadata(metadata);
  if (!targetIdentity) {
    return null;
  }
  return (
    conversations
      .filter(
        (conversation) =>
          isPageScopeMetadata(conversation.metadata) &&
          pageIdentityForMetadata(conversation.metadata) === targetIdentity,
      )
      .sort(sortByUpdatedAtDesc)[0] ?? null
  );
}

function normalizedPageMetadata(
  metadata: ConversationMetadata | null | undefined,
): Record<string, string> {
  const next: Record<string, string> = {};
  const scope = trimOptionalString(metadata?.scope);
  if (scope) next.scope = scope;
  const pageId = trimOptionalString(metadata?.pageId);
  if (pageId) next.pageId = pageId;
  const sourceConversationId = trimOptionalString(
    metadata?.sourceConversationId,
  );
  if (sourceConversationId) next.sourceConversationId = sourceConversationId;
  const terminalBridgeConversationId = trimOptionalString(
    metadata?.terminalBridgeConversationId,
  );
  if (terminalBridgeConversationId) {
    next.terminalBridgeConversationId = terminalBridgeConversationId;
  }
  return next;
}

function pageMetadataEquals(
  left: ConversationMetadata | null | undefined,
  right: ConversationMetadata | null | undefined,
): boolean {
  const normalizedLeft = normalizedPageMetadata(left);
  const normalizedRight = normalizedPageMetadata(right);
  const leftKeys = Object.keys(normalizedLeft).sort();
  const rightKeys = Object.keys(normalizedRight).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key, index) =>
      key === rightKeys[index] && normalizedLeft[key] === normalizedRight[key],
  );
}

export async function resolveScopedConversation(params: {
  title: string;
  metadata: ConversationMetadata;
}): Promise<Conversation> {
  const { conversations } = await client.listConversations();
  const existing = findPageScopedConversation(conversations, params.metadata);
  const normalizedTitle = params.title.trim() || "Chat";

  if (existing) {
    if (
      existing.title === normalizedTitle &&
      pageMetadataEquals(existing.metadata, params.metadata)
    ) {
      return existing;
    }

    const { conversation } = await client.updateConversation(existing.id, {
      title: normalizedTitle,
      metadata: params.metadata,
    });
    return conversation;
  }

  const { conversation } = await client.createConversation(normalizedTitle, {
    metadata: params.metadata,
  });
  return conversation;
}
