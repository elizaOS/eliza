/**
 * Keyless catalog coverage for the core DOCUMENT umbrella action's delete
 * contract (#16942). Runs on the pr-deterministic lane; live-document-delete
 * proves a real model routes the same path from natural phrasing.
 *
 * Exercises the real DOCUMENT handler and DocumentService end to end against
 * real DB state: a seeded global document is listed, a non-owner delete is
 * refused by the owner-only mutation wall (the document must survive), the
 * owner delete succeeds (the document must actually be gone), and the
 * not-found / missing-id rejections are pinned. The guest room's account maps
 * to a second entity that is NOT the executor-configured canonical owner
 * (ELIZA_ADMIN_ENTITY_ID); the seed makes it a connector-admin (ADMIN) via
 * the roles whitelist + a stamped connector identity, matching
 * live-document-delete's fixture, so the wall is exercised with the real
 * roles.ts resolution against the strongest non-owner tier it admits,
 * nothing mocked.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  checkSenderRole,
  setConnectorAdminWhitelist,
  stringToUuid,
} from "@elizaos/core";
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

const SCENARIO_ID = "deterministic-document-actions";
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

// The seed learns the content-addressed document id only at runtime, after the
// turn objects are already constructed — so the delete turns share these
// mutable parameter records and the seed fills in `documentId` before any turn
// runs.
let seededDocumentId: UUID | null = null;
const guestDeleteParams: JsonRecord = { action: "delete" };
const ownerDeleteParams: JsonRecord = { action: "delete" };

// Stable platform id stamped onto the guest entity + whitelisted so the guest
// resolves as connector-admin (ADMIN). Entity metadata survives message
// processing (merged per source key); world-metadata role grants do not.
const GUEST_STABLE_ID = `${SCENARIO_ID}-guest-admin`;

// Pins the tier the whitelist fixture actually resolves to (#16963). If the
// connector stamp or whitelist silently stops applying, the guest degrades to
// GUEST and the mutation-wall refusal would still pass — for the wrong reason
// (any non-owner is refused). This probe runs the real roles.ts resolution the
// DOCUMENT handler uses, so a degraded fixture is a hard failure instead.
async function expectGuestResolvesAdmin(
  runtime: ScenarioRuntime,
): Promise<string | undefined> {
  const probe = {
    entityId: stringToUuid(`scenario-account:${SCENARIO_ID}:guest`) as UUID,
    roomId: stringToUuid(`scenario-room:${SCENARIO_ID}:guest`) as UUID,
    agentId: runtime.agentId,
    content: { text: "" },
  } as Memory;
  const check = await checkSenderRole(runtime, probe);
  if (!check) return "guest role resolution found no world for the guest room";
  if (check.role !== "ADMIN") {
    return `expected the whitelisted guest to resolve as ADMIN, saw ${check.role}`;
  }
  return check.isOwner
    ? "guest must never resolve as owner — the wall test would be vacuous"
    : undefined;
}

function getDocumentService(ctx: ScenarioContext): DocumentService | null {
  const runtime = ctx.runtime as ScenarioRuntime;
  const service = runtime.getService<DocumentService>(
    DocumentService.serviceType,
  );
  return service ?? null;
}

function findDocumentCall(
  execution: ScenarioTurnExecution,
): CapturedAction | null {
  return (
    execution.actionsCalled.find(
      (candidate) => candidate.actionName === "DOCUMENT",
    ) ?? null
  );
}

function expectDocumentTurn(
  execution: ScenarioTurnExecution,
  expected: {
    success: boolean;
    subaction: string;
    values?: JsonRecord;
  },
): string | undefined {
  const action = findDocumentCall(execution);
  if (!action) {
    return `expected DOCUMENT action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
  }
  if (action.result?.success !== expected.success) {
    return `expected DOCUMENT result.success=${expected.success}, saw ${JSON.stringify(action.result)}`;
  }
  const data = isRecord(action.result?.data) ? action.result.data : {};
  if (data.subaction !== expected.subaction) {
    return `expected DOCUMENT subaction=${expected.subaction}, saw ${JSON.stringify(data.subaction)}`;
  }
  const values = isRecord(action.result?.values) ? action.result.values : {};
  for (const [key, expectedValue] of Object.entries(expected.values ?? {})) {
    if (JSON.stringify(values[key]) !== JSON.stringify(expectedValue)) {
      return `expected DOCUMENT values.${key}=${JSON.stringify(expectedValue)}, saw ${JSON.stringify(values[key])}`;
    }
  }
  return undefined;
}

function expectSeededDocumentListed(
  execution: ScenarioTurnExecution,
): string | undefined {
  const structural = expectDocumentTurn(execution, {
    success: true,
    subaction: "list",
  });
  if (structural) return structural;
  const action = findDocumentCall(execution);
  const values = isRecord(action?.result?.values) ? action.result.values : {};
  const documents = Array.isArray(values.documents) ? values.documents : [];
  const ids = documents
    .filter(isRecord)
    .map((document) => document.id)
    .filter((id): id is string => typeof id === "string");
  if (!seededDocumentId) return "seeded document id was not recorded";
  if (!ids.includes(seededDocumentId)) {
    return `expected the seeded document ${seededDocumentId} in the list, saw ${JSON.stringify(ids)}`;
  }
  return undefined;
}

export default scenario({
  id: "deterministic-document-actions",
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "model-free",
    reason:
      "Direct action turns exercise runtime contracts without model calls.",
  },
  title: "Deterministic DOCUMENT delete contract with owner-only wall",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "documents", "delete"],
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
        const room = await runtime.getRoom(ctx.primaryRoomId as UUID);
        if (!room?.worldId) return "primary room world was not created";
        const stored = await service.addDocument({
          worldId: room.worldId,
          roomId: ctx.primaryRoomId as UUID,
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
        guestDeleteParams.documentId = seededDocumentId;
        ownerDeleteParams.documentId = seededDocumentId;
        return undefined;
      },
    },
    {
      type: "custom",
      name: "whitelist the guest entity as a connector admin",
      // An ungranted entity resolves to GUEST; the whitelist makes it ADMIN,
      // pinning that even the strongest non-owner tier is refused by the
      // owner-only mutation wall, mirroring live-document-delete's fixture.
      apply: async (ctx) => {
        const runtime = ctx.runtime as ScenarioRuntime;
        const guestId = stringToUuid(
          `scenario-account:${SCENARIO_ID}:guest`,
        ) as UUID;
        setConnectorAdminWhitelist(runtime, { telegram: [GUEST_STABLE_ID] });
        const entity = (await runtime.getEntitiesByIds([guestId]))[0] ?? null;
        if (!entity) return "guest entity was not created by the executor";
        entity.metadata = {
          ...entity.metadata,
          telegram: { userId: GUEST_STABLE_ID },
        };
        await runtime.updateEntities([entity]);
        return expectGuestResolvesAdmin(runtime);
      },
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "clear the connector-admin whitelist",
      // The pr-deterministic lane shares one runtime across scenarios; a
      // lingering whitelist could leak ADMIN into a later scenario's entities.
      apply: (ctx) => {
        setConnectorAdminWhitelist(ctx.runtime as ScenarioRuntime, undefined);
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "owner lists stored documents",
      text: "what documents do I have stored?",
      actionName: "DOCUMENT",
      room: "main",
      options: { parameters: { action: "list" } },
      assertTurn: expectSeededDocumentListed,
    },
    {
      kind: "action",
      name: "non-owner delete is refused by the mutation wall",
      text: "delete the quarterly onboarding guide document",
      actionName: "DOCUMENT",
      room: "guest",
      options: { parameters: guestDeleteParams },
      responseIncludesAny: [
        "Only the owner can edit or delete global and owner-private documents",
      ],
      assertTurn: (execution) => {
        const structural = expectDocumentTurn(execution, {
          success: false,
          subaction: "delete",
          values: { error: "forbidden" },
        });
        if (structural) return structural;
        const action = findDocumentCall(execution);
        const values = isRecord(action?.result?.values)
          ? action.result.values
          : {};
        return values.documentId === seededDocumentId
          ? undefined
          : `expected values.documentId=${seededDocumentId}, saw ${JSON.stringify(values.documentId)}`;
      },
    },
    {
      kind: "action",
      name: "document survives the refused delete",
      text: "what documents do I have stored?",
      actionName: "DOCUMENT",
      room: "main",
      options: { parameters: { action: "list" } },
      assertTurn: expectSeededDocumentListed,
    },
    {
      kind: "action",
      name: "owner delete removes the document",
      text: "delete that onboarding document",
      actionName: "DOCUMENT",
      room: "main",
      options: { parameters: ownerDeleteParams },
      assertTurn: (execution) => {
        const structural = expectDocumentTurn(execution, {
          success: true,
          subaction: "delete",
        });
        if (structural) return structural;
        const action = findDocumentCall(execution);
        const values = isRecord(action?.result?.values)
          ? action.result.values
          : {};
        return values.documentId === seededDocumentId
          ? undefined
          : `expected values.documentId=${seededDocumentId}, saw ${JSON.stringify(values.documentId)}`;
      },
    },
    {
      kind: "action",
      name: "deleting the same document again reports not found",
      text: "delete that onboarding document again",
      actionName: "DOCUMENT",
      room: "main",
      options: { parameters: ownerDeleteParams },
      assertTurn: (execution) =>
        expectDocumentTurn(execution, {
          success: false,
          subaction: "delete",
          values: { error: "not_found" },
        }),
    },
    {
      kind: "action",
      name: "delete without any id is rejected",
      text: "delete the document",
      actionName: "DOCUMENT",
      room: "main",
      options: { parameters: { action: "delete" } },
      responseIncludesAny: ["No valid document id found in the request"],
      assertTurn: (execution) =>
        expectDocumentTurn(execution, {
          success: false,
          subaction: "delete",
          values: { error: "invalid_id" },
        }),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      // Runs before cleanup clears the whitelist, so it proves the ADMIN tier
      // held through the refusal turn — not just at seed time (#16963).
      name: "whitelisted guest still resolves as connector-admin (ADMIN)",
      predicate: (ctx) =>
        expectGuestResolvesAdmin(ctx.runtime as ScenarioRuntime),
    },
    {
      type: "actionCalled",
      actionName: "DOCUMENT",
      status: "success",
      minCount: 3,
    },
    {
      type: "custom",
      name: "seeded document is actually gone from the store",
      predicate: async (ctx) => {
        const service = getDocumentService(ctx);
        if (!service) return "documents service was not available";
        if (!seededDocumentId) return "seeded document id was not recorded";
        const remaining = await service.getDocumentById(seededDocumentId);
        return remaining
          ? `expected ${seededDocumentId} to be deleted, but it still exists`
          : undefined;
      },
    },
  ],
});
