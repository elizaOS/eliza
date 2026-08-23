/**
 * Live-model proof for the view-chat DOCUMENT delete acceptance bar (#16942):
 * "delete that document" in natural phrasing must make a REAL model route the
 * semantic DOCUMENT action with a delete op — never a raw selector
 * (`agent-fill`/`agent-click`) on the Knowledge view — and the stored document
 * must actually be gone from the real DocumentService afterwards (state
 * assertion, not reply phrasing). A non-owner turn first attempts the same
 * delete and must be refused by the owner-only mutation wall while the
 * document survives. deterministic-document-actions pins the same payload
 * contract keyless on the PR lane.
 *
 * The guest room's account maps to a second entity that is NOT the
 * executor-configured canonical owner (ELIZA_ADMIN_ENTITY_ID). The seed makes
 * it a connector-admin (ADMIN) via the roles whitelist + a stamped connector
 * identity on the entity — the strongest non-owner tier the role system
 * admits. An ungranted entity resolves to GUEST and never even sees the
 * documents context (defense in depth hides the action before the wall can
 * fire), and world-metadata role grants do not survive message processing
 * (each turn re-upserts the world with fresh metadata), so the whitelist is
 * the durable non-owner fixture. Even as ADMIN the handler's owner-only
 * mutation wall must refuse the delete, exercising the real roles.ts
 * resolution end to end.
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { setConnectorAdminWhitelist, stringToUuid } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  DocumentService,
  documentsPlugin,
} from "../../../core/src/features/documents/index";

const SCENARIO_ID = "live-document-delete";
const DOCUMENT_TITLE = "Quarterly Onboarding Guide";
const DOCUMENT_CONTENT = [
  "# Quarterly Onboarding Guide",
  "",
  "Welcome aboard. Week one covers workstation setup, security training,",
  "and the deployment checklist. The onboarding buddy roster rotates on the",
  "first Monday of each quarter.",
].join("\n");

type JsonRecord = Record<string, unknown>;

/**
 * The real AgentRuntime handed to seeds/checks via ScenarioContext (typed
 * `unknown` in the schema package to keep it dependency-free), plus the
 * plugin-registration surface the seed uses. Never a hand-built partial.
 */
type ScenarioRuntime = IAgentRuntime & {
  plugins?: Array<{ name: string }>;
  registerPlugin: (plugin: unknown) => Promise<void>;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

let seededDocumentId: UUID | null = null;

// Stable platform id stamped onto the guest entity + whitelisted so the guest
// resolves as connector-admin (ADMIN). Entity metadata survives message
// processing (it is merged per source key), unlike world-metadata role grants
// which each processed message clobbers.
const GUEST_STABLE_ID = `${SCENARIO_ID}-guest-admin`;

/**
 * The guest room's runtime identity, read from the executor-published topology
 * rather than re-derived here. The executor alone owns the
 * `scenario-account:<scenarioId>:<account>` recipe and has already changed it
 * once (#24842 namespaced accounts per scenario); a scenario that spells it out
 * a second time stamps its roles onto an entity nobody speaks as the moment the
 * executor moves. One derivation, one seam.
 */
function guestIdentity(
  ctx: ScenarioContext,
): { entityId: UUID; roomId: UUID } | string {
  const entityId = ctx.roomEntityIds?.guest;
  const roomId = ctx.roomIds?.guest;
  if (!entityId || !roomId) {
    return "executor did not publish the guest room identity (ctx.roomEntityIds/ctx.roomIds)";
  }
  return { entityId: entityId as UUID, roomId: roomId as UUID };
}

function getDocumentService(ctx: ScenarioContext): DocumentService | null {
  const runtime = ctx.runtime as ScenarioRuntime;
  const service = runtime.getService<DocumentService>(
    DocumentService.serviceType,
  );
  return service ?? null;
}

function actionParams(action: CapturedAction): JsonRecord {
  const envelope = isRecord(action.parameters) ? action.parameters : {};
  return isRecord(envelope.parameters) ? envelope.parameters : envelope;
}

function documentCalls(execution: ScenarioTurnExecution): CapturedAction[] {
  return execution.actionsCalled.filter(
    (candidate) => candidate.actionName === "DOCUMENT",
  );
}

function resultValues(action: CapturedAction): JsonRecord {
  return isRecord(action.result?.values) ? action.result.values : {};
}

function resultData(action: CapturedAction): JsonRecord {
  return isRecord(action.result?.data) ? action.result.data : {};
}

// The raw-selector negative the acceptance bar names: the Knowledge view's
// delete control must be reached through the semantic DOCUMENT action, never
// the generic synthetic-DOM bridge.
function noSyntheticDomFallback(ctx: {
  actionsCalled: CapturedAction[];
}): string | undefined {
  for (const call of ctx.actionsCalled) {
    if (call.actionName === "VIEWS") {
      return `expected no VIEWS synthetic-DOM fallback, saw VIEWS with ${JSON.stringify(actionParams(call))}`;
    }
    const capability = actionParams(call).capability;
    if (capability === "agent-fill" || capability === "agent-click") {
      return `expected no agent-fill/agent-click, saw capability=${String(capability)}`;
    }
  }
  return undefined;
}

function expectListWithSeededDocument(
  execution: ScenarioTurnExecution,
): string | undefined {
  const listCall = documentCalls(execution).find(
    (call) => resultData(call).subaction === "list",
  );
  if (!listCall) {
    return `expected a DOCUMENT list call, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
  }
  if (listCall.result?.success !== true) {
    return `expected DOCUMENT list success=true, saw ${JSON.stringify(listCall.result)}`;
  }
  const documents = Array.isArray(resultValues(listCall).documents)
    ? (resultValues(listCall).documents as unknown[])
    : [];
  const ids = documents
    .filter(isRecord)
    .map((document) => document.id)
    .filter((id): id is string => typeof id === "string");
  if (!seededDocumentId) return "seeded document id was not recorded";
  if (!ids.includes(seededDocumentId)) {
    return `expected the seeded document ${seededDocumentId} in the list, saw ${JSON.stringify(ids)}`;
  }
  return noSyntheticDomFallback({ actionsCalled: execution.actionsCalled });
}

// The model may legitimately re-list before deleting inside the same turn, so
// the delete expectation searches all DOCUMENT calls for the delete op instead
// of assuming the turn produced exactly one call.
function findDeleteCall(
  execution: ScenarioTurnExecution,
): CapturedAction | null {
  return (
    documentCalls(execution).find(
      (call) => resultData(call).subaction === "delete",
    ) ?? null
  );
}

function expectRefusedDelete(
  execution: ScenarioTurnExecution,
): string | undefined {
  const deleteCall = findDeleteCall(execution);
  if (!deleteCall) {
    return `expected a DOCUMENT delete attempt, saw ${
      execution.actionsCalled
        .map(
          (candidate) =>
            `${candidate.actionName}:${String(resultData(candidate).subaction ?? "")}`,
        )
        .join(", ") || "none"
    }`;
  }
  if (deleteCall.result?.success !== false) {
    return `expected the non-owner delete to fail, saw ${JSON.stringify(deleteCall.result)}`;
  }
  const error = resultValues(deleteCall).error;
  if (error !== "forbidden") {
    return `expected values.error="forbidden", saw ${JSON.stringify(error)}`;
  }
  return noSyntheticDomFallback({ actionsCalled: execution.actionsCalled });
}

function expectOwnerDeleteSucceeded(
  execution: ScenarioTurnExecution,
): string | undefined {
  const deleteCall = findDeleteCall(execution);
  if (!deleteCall) {
    return `expected a DOCUMENT delete call, saw ${
      execution.actionsCalled
        .map(
          (candidate) =>
            `${candidate.actionName}:${String(resultData(candidate).subaction ?? "")}`,
        )
        .join(", ") || "none"
    }`;
  }
  if (deleteCall.result?.success !== true) {
    return `expected DOCUMENT delete success=true, saw ${JSON.stringify(deleteCall.result)}`;
  }
  const documentId = resultValues(deleteCall).documentId;
  if (documentId !== seededDocumentId) {
    return `expected values.documentId=${seededDocumentId}, saw ${JSON.stringify(documentId)}`;
  }
  return noSyntheticDomFallback({ actionsCalled: execution.actionsCalled });
}

export default scenario({
  id: "live-document-delete",
  lane: "live-only",
  title: "Real LLM routes 'delete that document' to DOCUMENT with owner wall",
  domain: "documents",
  tags: ["live", "real-llm", "documents", "views-chat-integration", "mvp"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "client_chat",
      title: "Document Owner",
    },
    {
      id: "guest",
      account: `${SCENARIO_ID}:guest`,
      source: "client_chat",
      title: "Document Guest",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "register the core documents plugin",
      apply: async (ctx) => {
        const runtime = ctx.runtime as ScenarioRuntime;
        const registered = (runtime.plugins ?? []).some(
          (plugin) => plugin.name === documentsPlugin.name,
        );
        if (!registered) await runtime.registerPlugin(documentsPlugin);
        await runtime.getServiceLoadPromise?.(DocumentService.serviceType);
        return runtime.getService(DocumentService.serviceType)
          ? undefined
          : "documents service did not start";
      },
    },
    {
      type: "custom",
      name: "seed one global document through the real service",
      apply: async (ctx) => {
        const runtime = ctx.runtime as ScenarioRuntime;
        const service = getDocumentService(ctx);
        if (!service) return "documents service was not available";
        if (!ctx.primaryRoomId || !ctx.primaryUserId) {
          return "primary room/user were not set by the executor";
        }
        const guest = guestIdentity(ctx);
        if (typeof guest === "string") return guest;
        const room = await runtime.getRoom(ctx.primaryRoomId as UUID);
        if (!room?.worldId) return "primary room world was not created";
        const stored = await service.addDocument({
          worldId: room.worldId,
          // ADMIN is intentionally room-limited for document reads. Seed the
          // global record in the guest room so the non-owner can identify the
          // target without widening that privacy boundary; OWNER still has
          // global visibility and performs the successful delete later.
          roomId: guest.roomId,
          entityId: ctx.primaryUserId as UUID,
          clientDocumentId: stringToUuid(`${SCENARIO_ID}:doc`) as UUID,
          contentType: "text/markdown",
          originalFilename: "quarterly-onboarding-guide.md",
          content: DOCUMENT_CONTENT,
          scope: "global",
          addedBy: ctx.primaryUserId as UUID,
          addedByRole: "OWNER",
          addedFrom: "import",
          metadata: { title: DOCUMENT_TITLE },
        });
        seededDocumentId = stored.clientDocumentId as UUID;
        return undefined;
      },
    },
    {
      type: "custom",
      name: "whitelist the guest entity as a connector admin",
      apply: async (ctx) => {
        const runtime = ctx.runtime as ScenarioRuntime;
        const guest = guestIdentity(ctx);
        if (typeof guest === "string") return guest;
        setConnectorAdminWhitelist(runtime, { telegram: [GUEST_STABLE_ID] });
        const entity =
          (await runtime.getEntitiesByIds([guest.entityId]))[0] ?? null;
        if (!entity) return "guest entity was not created by the executor";
        entity.metadata = {
          ...entity.metadata,
          telegram: { userId: GUEST_STABLE_ID },
        };
        await runtime.updateEntities([entity]);
        return undefined;
      },
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "clear the connector-admin whitelist",
      apply: (ctx) => {
        setConnectorAdminWhitelist(ctx.runtime as ScenarioRuntime, undefined);
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "non-owner lists the stored documents",
      room: "guest",
      text: "What documents are stored right now?",
      expectedActions: ["DOCUMENT"],
      assertTurn: expectListWithSeededDocument,
    },
    {
      kind: "message",
      name: "non-owner delete is refused by the mutation wall",
      room: "guest",
      text: `Delete the ${DOCUMENT_TITLE} document.`,
      expectedActions: ["DOCUMENT"],
      assertTurn: expectRefusedDelete,
    },
    {
      kind: "message",
      name: "owner lists the stored documents",
      room: "main",
      text: "What documents do I have stored?",
      expectedActions: ["DOCUMENT"],
      assertTurn: expectListWithSeededDocument,
    },
    {
      kind: "message",
      name: "owner deletes the document by natural phrasing",
      room: "main",
      text: "Delete that onboarding guide document.",
      expectedActions: ["DOCUMENT"],
      assertTurn: expectOwnerDeleteSucceeded,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "DOCUMENT",
      status: "success",
      minCount: 3,
    },
    {
      type: "selectedActionArguments",
      actionName: "DOCUMENT",
      includesAll: [/delete/i],
    },
    {
      type: "custom",
      // Survival across the refused non-owner delete is proven by turn
      // ordering: the owner list turn re-observed the document AFTER the
      // guest refusal. By final-check time the owner delete has run, so the
      // document must be gone from the real store.
      name: "seeded document is actually gone from the store",
      predicate: async (ctx) => {
        if (!seededDocumentId) return "seeded document id was not recorded";
        const service = getDocumentService(ctx);
        if (!service) return "documents service was not available";
        const remaining = await service.getDocumentById(seededDocumentId);
        return remaining
          ? `expected ${seededDocumentId} to be deleted by the owner turn, but it still exists`
          : undefined;
      },
    },
    {
      type: "custom",
      name: "no synthetic-DOM (VIEWS/agent-fill/agent-click) fallback was used",
      predicate: noSyntheticDomFallback,
    },
  ],
});
