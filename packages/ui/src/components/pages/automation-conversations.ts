import { client } from "../../api";
import type {
  Conversation,
  ConversationMetadata,
} from "../../api/client-types-chat";

const AUTOMATION_SCOPES = new Set([
  "automation-coordinator",
  "automation-workflow",
  "automation-workflow-draft",
  "automation-draft",
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

export function isAutomationConversationMetadata(
  metadata: ConversationMetadata | null | undefined,
): boolean {
  return metadata?.scope ? AUTOMATION_SCOPES.has(metadata.scope) : false;
}

export function isAutomationConversation(
  conversation: Pick<Conversation, "metadata"> | null | undefined,
): boolean {
  return isAutomationConversationMetadata(conversation?.metadata);
}

export function getAutomationBridgeConversationId(
  activeConversationId: string | null | undefined,
  conversations: Conversation[],
): string | undefined {
  const normalizedActiveId = trimOptionalString(activeConversationId);
  if (!normalizedActiveId) {
    return undefined;
  }

  const activeConversation = conversations.find(
    (conversation) => conversation.id === normalizedActiveId,
  );
  if (isAutomationConversation(activeConversation)) {
    return undefined;
  }

  return normalizedActiveId;
}

export function buildCoordinatorConversationMetadata(
  taskId: string,
  bridgeConversationId?: string,
): ConversationMetadata {
  return {
    scope: "automation-coordinator",
    automationType: "coordinator_text",
    taskId,
    ...(bridgeConversationId
      ? {
          sourceConversationId: bridgeConversationId,
          terminalBridgeConversationId: bridgeConversationId,
        }
      : {}),
  };
}

export function buildCoordinatorTriggerConversationMetadata(
  triggerId: string,
  bridgeConversationId?: string,
): ConversationMetadata {
  return {
    scope: "automation-coordinator",
    automationType: "coordinator_text",
    triggerId,
    ...(bridgeConversationId
      ? {
          sourceConversationId: bridgeConversationId,
          terminalBridgeConversationId: bridgeConversationId,
        }
      : {}),
  };
}

export function buildWorkflowConversationMetadata(
  workflowId: string,
  workflowName: string,
  bridgeConversationId?: string,
): ConversationMetadata {
  return {
    scope: "automation-workflow",
    automationType: "workflow",
    workflowId,
    workflowName,
    ...(bridgeConversationId
      ? {
          sourceConversationId: bridgeConversationId,
          terminalBridgeConversationId: bridgeConversationId,
        }
      : {}),
  };
}

export function buildWorkflowDraftConversationMetadata(
  draftId: string,
  bridgeConversationId?: string,
): ConversationMetadata {
  return {
    scope: "automation-workflow-draft",
    automationType: "workflow",
    draftId,
    ...(bridgeConversationId
      ? {
          sourceConversationId: bridgeConversationId,
          terminalBridgeConversationId: bridgeConversationId,
        }
      : {}),
  };
}

export function buildAutomationDraftConversationMetadata(
  draftId: string,
  bridgeConversationId?: string,
): ConversationMetadata {
  return {
    scope: "automation-draft",
    draftId,
    ...(bridgeConversationId
      ? {
          sourceConversationId: bridgeConversationId,
          terminalBridgeConversationId: bridgeConversationId,
        }
      : {}),
  };
}

export function buildAutomationResponseRoutingMetadata(
  metadata: ConversationMetadata,
): Record<string, unknown> | undefined {
  if (
    metadata.scope === "automation-coordinator" ||
    metadata.scope === "automation-workflow" ||
    metadata.scope === "automation-workflow-draft" ||
    metadata.scope === "automation-draft"
  ) {
    return {
      __responseContext: {
        primaryContext: "automation",
        secondaryContexts: ["automation", "code", "admin"],
      },
    };
  }
  return undefined;
}

function normalizedMetadata(
  metadata: ConversationMetadata | null | undefined,
): Record<string, string> {
  const next: Record<string, string> = {};

  const scope = trimOptionalString(metadata?.scope);
  if (scope) next.scope = scope;

  const automationType = trimOptionalString(metadata?.automationType);
  if (automationType) next.automationType = automationType;

  const taskId = trimOptionalString(metadata?.taskId);
  if (taskId) next.taskId = taskId;

  const triggerId = trimOptionalString(metadata?.triggerId);
  if (triggerId) next.triggerId = triggerId;

  const workflowId = trimOptionalString(metadata?.workflowId);
  if (workflowId) next.workflowId = workflowId;

  const workflowName = trimOptionalString(metadata?.workflowName);
  if (workflowName) next.workflowName = workflowName;

  const draftId = trimOptionalString(metadata?.draftId);
  if (draftId) next.draftId = draftId;

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

function automationIdentityForMetadata(
  metadata: ConversationMetadata | null | undefined,
): string | null {
  if (metadata?.taskId) {
    return `task:${metadata.taskId}`;
  }
  if (metadata?.triggerId) {
    return `trigger:${metadata.triggerId}`;
  }
  if (metadata?.workflowId) {
    return `workflow:${metadata.workflowId}`;
  }
  if (metadata?.draftId) {
    return `workflow-draft:${metadata.draftId}`;
  }
  return null;
}

function metadataMatchesIdentity(
  left: ConversationMetadata | null | undefined,
  right: ConversationMetadata | null | undefined,
): boolean {
  const leftIdentity = automationIdentityForMetadata(left);
  const rightIdentity = automationIdentityForMetadata(right);
  if (!leftIdentity || !rightIdentity) {
    return false;
  }
  return leftIdentity === rightIdentity;
}

function metadataEquals(
  left: ConversationMetadata | null | undefined,
  right: ConversationMetadata | null | undefined,
): boolean {
  const normalizedLeft = normalizedMetadata(left);
  const normalizedRight = normalizedMetadata(right);
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

export function findAutomationConversation(
  conversations: Conversation[],
  metadata: ConversationMetadata,
): Conversation | null {
  return (
    conversations
      .filter(
        (conversation) =>
          isAutomationConversation(conversation) &&
          metadataMatchesIdentity(conversation.metadata, metadata),
      )
      .sort(sortByUpdatedAtDesc)[0] ?? null
  );
}

export async function resolveAutomationConversation(params: {
  title: string;
  metadata: ConversationMetadata;
}): Promise<Conversation> {
  const { conversations } = await client.listConversations();
  const existing = findAutomationConversation(conversations, params.metadata);
  const normalizedTitle = params.title.trim() || "Automation";

  if (existing) {
    if (
      existing.title === normalizedTitle &&
      metadataEquals(existing.metadata, params.metadata)
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
