import type {
  DraftRequest,
  IAgentRuntime,
  MessageSource,
  SendPolicy,
} from "@elizaos/core";
import { getConnectorRegistry } from "../connectors/registry.js";

/**
 * Map a `MessageSource` (the triage-layer enum) to the corresponding
 * `ConnectorRegistry` kind. Gmail is a Google capability, not a separate
 * connector kind, so the source `"gmail"` resolves to connector `"google"`.
 *
 * Sources without a matching connector (e.g. `browser_bridge`) return `null`
 * and the default approval policy (no approval) applies.
 */
const SOURCE_TO_CONNECTOR_KIND: Partial<Record<MessageSource, string>> = {
  gmail: "google",
  discord: "discord",
  telegram: "telegram",
  twitter: "x",
  imessage: "imessage",
  signal: "signal",
  whatsapp: "whatsapp",
  calendly: "calendly",
};

function approvalRequiredForSource(
  runtime: IAgentRuntime,
  source: MessageSource,
): boolean {
  const kind = SOURCE_TO_CONNECTOR_KIND[source];
  if (!kind) return false;
  const registry = getConnectorRegistry(runtime);
  if (!registry) return false;
  return registry.get(kind)?.requiresApproval === true;
}

function makeApprovalDescription(draft: DraftRequest): string {
  const recipients = draft.to
    .map((entry) => entry.displayName ?? entry.identifier)
    .filter(Boolean)
    .join(", ");
  const subject = draft.subject ? ` (${draft.subject})` : "";
  const preview =
    draft.body.length > 240 ? `${draft.body.slice(0, 237)}...` : draft.body;
  const target = recipients.length > 0 ? recipients : "(no recipients)";
  return `Approve sending ${draft.source} to ${target}${subject}: ${preview}`;
}

function previewDraft(draft: DraftRequest): string {
  if (draft.body.length <= 200) return draft.body;
  return `${draft.body.slice(0, 197)}...`;
}

export function createOwnerSendPolicy(): SendPolicy {
  return {
    async shouldRequireApproval(runtime, draft) {
      return approvalRequiredForSource(runtime, draft.source);
    },
    async enqueueApproval(runtime, draft, executor) {
      if (typeof runtime.createTask !== "function") {
        throw new Error(
          "[OwnerSendPolicy] runtime.createTask is required for outbound approvals",
        );
      }
      const requestId = await runtime.createTask({
        name: `OWNER_SEND_APPROVAL_${Date.now()}`,
        description: makeApprovalDescription(draft),
        roomId:
          (draft.metadata?.roomId as string | undefined) ?? runtime.agentId,
        entityId:
          (draft.metadata?.entityId as string | undefined) ?? runtime.agentId,
        tags: ["AWAITING_CHOICE", "APPROVAL", "OWNER_SEND_APPROVAL"],
        metadata: {
          options: [
            { name: "confirm", description: "Send the drafted message" },
            { name: "cancel", description: "Do not send it" },
          ],
          approvalRequest: {
            timeoutMs: 24 * 60 * 60 * 1000,
            timeoutDefault: "cancel",
            createdAt: Date.now(),
            isAsync: true,
          },
          actionName: "OWNER_SEND_APPROVAL",
          source: draft.source,
          payload: {
            source: draft.source,
            inReplyToId: draft.inReplyToId ?? null,
            threadId: draft.threadId ?? null,
            to: draft.to,
            subject: draft.subject ?? null,
            body: draft.body,
            worldId: draft.worldId ?? null,
            channelId: draft.channelId ?? null,
          },
        },
      });
      // The execution callback is invoked by RESOLVE_REQUEST after the
      // owner approves. The executor reference is held by the triage service
      // until that flow runs; nothing to do synchronously here.
      void executor;
      return {
        requestId: requestId as unknown as string,
        preview: previewDraft(draft),
      };
    },
  };
}
