/**
 * Bridges core fact-memory rows into LifeOps's typed owner facts and entity
 * graph. Core owns the LLM extraction and facts table; this module is the
 * Personal Assistant-side projection that turns those durable rows into the
 * structural state LifeOps schedulers, policies, and relationship tools read.
 */
import { hasOwnerAccess, resolveKnowledgeGraphService } from "@elizaos/agent";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { SELF_ENTITY_ID } from "../entities/types.js";
import {
  applyExtractedEdges,
  type ExtractedEdge,
} from "../relationships/extraction.js";
import { asCacheRuntime } from "../runtime-cache.js";
import {
  type OwnerFactStore,
  type OwnerFactsPatch,
  resolveOwnerFactStore,
} from "./fact-store.js";
import {
  cleanHandle,
  cleanName,
  normalizePlatform,
  relationTypeForRole,
} from "./profile-hints.js";

const BRIDGED_FACT_IDS_CACHE_KEY = "eliza:lifeops:core-fact-memory-bridge:v1";
const MAX_BRIDGED_FACT_IDS = 1_000;

type FactMetadata = {
  source?: string;
  kind?: string;
  category?: string;
  structuredFields?: Record<string, unknown>;
  confidence?: number;
  lastConfirmedAt?: string;
};

type IdentityHint = {
  name: string;
  platform: string;
  handle: string;
};

type OwnerStringFactKey =
  | "preferredName"
  | "relationshipStatus"
  | "partnerName"
  | "orientation"
  | "gender"
  | "age"
  | "location"
  | "travelBookingPreferences"
  | "preferredNotificationChannel"
  | "locale"
  | "timezone";

export interface CoreFactMemoryBridgeResult {
  skipped: boolean;
  reason?: string;
  ownerFactKeys: string[];
  identityCount: number;
  relationshipCount: number;
}

interface BridgeDeps {
  ownerAccess?: typeof hasOwnerAccess;
  factStore?: OwnerFactStore;
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function factMetadata(memory: Memory): FactMetadata | null {
  const metadata = memory.metadata;
  if (!isRecord(metadata)) return null;
  const structured = isRecord(metadata.structuredFields)
    ? metadata.structuredFields
    : {};
  return {
    source: readString(metadata.source) ?? undefined,
    kind: readString(metadata.kind) ?? undefined,
    category: readString(metadata.category) ?? undefined,
    structuredFields: structured,
    confidence:
      typeof metadata.confidence === "number" ? metadata.confidence : undefined,
    lastConfirmedAt: readString(metadata.lastConfirmedAt) ?? undefined,
  };
}

function firstString(
  fields: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = readString(fields[key]);
    if (value) return value;
  }
  return null;
}

function setFact(
  patch: OwnerFactsPatch,
  key: OwnerStringFactKey,
  value: string | null,
): void {
  if (value) {
    patch[key] = value;
  }
}

function extractOwnerFacts(metadata: FactMetadata): OwnerFactsPatch {
  const fields = metadata.structuredFields ?? {};
  const patch: OwnerFactsPatch = {};
  const category = metadata.category;

  if (category === "identity") {
    // Alias lists cover older structured-field names while the prompt/schema
    // converge on the canonical camelCase keys. Do not recover from claim text
    // here; the core extractor owns language-specific value extraction.
    setFact(
      patch,
      "preferredName",
      firstString(fields, [
        "preferredName",
        "preferred_name",
        "name",
        "fullName",
        "full_name",
        "nickname",
        "goesBy",
        "goes_by",
        "displayName",
      ]),
    );
    setFact(
      patch,
      "orientation",
      firstString(fields, [
        "orientation",
        "sexualOrientation",
        "sexual_orientation",
      ]),
    );
    setFact(
      patch,
      "gender",
      firstString(fields, [
        "gender",
        "genderIdentity",
        "gender_identity",
        "pronouns",
      ]),
    );
    setFact(patch, "age", firstString(fields, ["age"]));
    setFact(
      patch,
      "location",
      firstString(fields, [
        "location",
        "city",
        "homeCity",
        "home_city",
        "home_location",
        "hometown",
        "country",
        "residence",
      ]),
    );
    setFact(
      patch,
      "timezone",
      firstString(fields, [
        "timezone",
        "timeZone",
        "time_zone",
        "ianaTimezone",
        "iana_timezone",
      ]),
    );
  }

  if (category === "relationship") {
    setFact(
      patch,
      "relationshipStatus",
      firstString(fields, [
        "relationshipStatus",
        "relationship_status",
        "status",
        "maritalStatus",
        "marital_status",
      ]),
    );
    setFact(
      patch,
      "partnerName",
      firstString(fields, [
        "partnerName",
        "partner_name",
        "partner",
        "spouse",
        "spouseName",
      ]),
    );
  }

  if (category === "preference") {
    setFact(
      patch,
      "locale",
      firstString(fields, ["locale", "languageLocale", "language_locale"]),
    );
    setFact(
      patch,
      "preferredNotificationChannel",
      firstString(fields, [
        "preferredNotificationChannel",
        "preferred_notification_channel",
        "notificationChannel",
        "notification_channel",
        "channel",
      ]),
    );
    setFact(
      patch,
      "travelBookingPreferences",
      firstString(fields, [
        "travelBookingPreferences",
        "travel_booking_preferences",
        "travelPreference",
        "travel_preference",
        "bookingPreference",
        "booking_preference",
      ]),
    );
  }

  return patch;
}

function edgeForSelfToPerson(
  name: string | null,
  type: string | null,
  confidence: number,
  metadata?: Record<string, unknown>,
): ExtractedEdge | null {
  if (!name || !type) return null;
  return {
    fromRef: { id: SELF_ENTITY_ID },
    toRef: { name, type: "person" },
    type,
    ...(metadata ? { metadata } : {}),
    confidence,
  };
}

function extractRelationshipEdges(metadata: FactMetadata): ExtractedEdge[] {
  const confidence = metadata.confidence ?? 0.7;
  const fields = metadata.structuredFields ?? {};
  const edges: ExtractedEdge[] = [];

  const structuredName = firstString(fields, [
    "person",
    "name",
    "target",
    "relatedPerson",
    "partner",
    "manager",
    "boss",
  ]);
  const structuredRole = firstString(fields, [
    "relationshipType",
    "relationship",
    "role",
    "type",
  ]);
  const structuredType = relationTypeForRole(structuredRole);
  const structuredEdge = edgeForSelfToPerson(
    structuredName,
    structuredType,
    confidence,
    structuredRole ? { extractedRole: structuredRole } : undefined,
  );
  if (structuredEdge) edges.push(structuredEdge);

  const organization =
    firstString(fields, ["company", "organization", "employer"]) ?? undefined;
  const orgName = cleanName(organization);
  if (orgName) {
    edges.push({
      fromRef: { id: SELF_ENTITY_ID },
      toRef: { name: orgName, type: "organization" },
      type: "works_at",
      confidence,
    });
  }

  return dedupeEdges(edges);
}

function extractIdentityHints(metadata: FactMetadata): IdentityHint[] {
  const hints: IdentityHint[] = [];
  const fields = metadata.structuredFields ?? {};
  const name = cleanName(
    firstString(fields, ["person", "name", "target", "relatedPerson"]) ??
      undefined,
  );
  const platform = firstString(fields, ["platform", "service", "network"]);
  const handle = cleanHandle(
    firstString(fields, ["handle", "username", "account", "profile"]) ??
      undefined,
  );
  if (name && platform && handle) {
    hints.push({ name, platform: normalizePlatform(platform), handle });
  }
  return hints;
}

function edgeKey(edge: ExtractedEdge): string {
  return [
    edge.fromRef.id ?? edge.fromRef.name ?? "",
    edge.toRef.id ?? edge.toRef.name ?? "",
    edge.type,
  ]
    .map((value) => value.toLowerCase())
    .join("|");
}

function dedupeEdges(edges: ExtractedEdge[]): ExtractedEdge[] {
  const seen = new Set<string>();
  const result: ExtractedEdge[] = [];
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result;
}

async function readBridgedFactIds(
  runtime: IAgentRuntime,
): Promise<Set<string>> {
  const cache = asCacheRuntime(runtime);
  const stored = await cache.getCache<unknown>(BRIDGED_FACT_IDS_CACHE_KEY);
  if (!Array.isArray(stored)) return new Set();
  return new Set(
    stored
      .map((value) => (typeof value === "string" ? value : null))
      .filter((value): value is string => Boolean(value)),
  );
}

async function markFactBridged(
  runtime: IAgentRuntime,
  factId: string,
): Promise<void> {
  const bridged = await readBridgedFactIds(runtime);
  bridged.delete(factId);
  const next = [factId, ...Array.from(bridged)].slice(0, MAX_BRIDGED_FACT_IDS);
  await asCacheRuntime(runtime).setCache(BRIDGED_FACT_IDS_CACHE_KEY, next);
}

function skipped(reason: string): CoreFactMemoryBridgeResult {
  return {
    skipped: true,
    reason,
    ownerFactKeys: [],
    identityCount: 0,
    relationshipCount: 0,
  };
}

function factIdFor(memory: Memory, memoryId?: UUID): string | null {
  return readString(memoryId) ?? readString(memory.id);
}

export async function bridgeCoreFactMemory(
  runtime: IAgentRuntime,
  memory: Memory,
  deps: BridgeDeps & { memoryId?: UUID } = {},
): Promise<CoreFactMemoryBridgeResult> {
  const metadata = factMetadata(memory);
  if (metadata?.source !== "fact_extractor") return skipped("not_core_fact");
  if (metadata.kind !== "durable") return skipped("not_durable");
  const factId = factIdFor(memory, deps.memoryId);
  if (!factId) return skipped("missing_fact_id");
  if ((await readBridgedFactIds(runtime)).has(factId)) {
    return skipped("already_bridged");
  }

  const ownerAccess = deps.ownerAccess ?? hasOwnerAccess;
  if (!(await ownerAccess(runtime, memory))) {
    await markFactBridged(runtime, factId);
    return skipped("not_owner_fact");
  }

  const patch = extractOwnerFacts(metadata);
  const ownerFactKeys = Object.keys(patch);
  if (ownerFactKeys.length > 0) {
    await (deps.factStore ?? resolveOwnerFactStore(runtime)).update(patch, {
      source: "agent_inferred",
      recordedAt:
        metadata.lastConfirmedAt ??
        (deps.now ? deps.now() : new Date()).toISOString(),
      note: `core fact-memory bridge from fact:${factId}`,
    });
  }

  let identityCount = 0;
  let relationshipCount = 0;
  const identityHints = extractIdentityHints(metadata);
  const edges = extractRelationshipEdges(metadata);
  if (identityHints.length > 0 || edges.length > 0) {
    const knowledgeGraph = resolveKnowledgeGraphService(runtime);
    if (!knowledgeGraph) {
      throw new Error(
        "[core-fact-memory-bridge] KnowledgeGraphService is not registered on the runtime",
      );
    }
    const entityStore = knowledgeGraph.getEntityStore(runtime.agentId);
    const relationshipStore = knowledgeGraph.getRelationshipStore(
      runtime.agentId,
    );
    for (const identity of identityHints) {
      await entityStore.observeIdentity({
        platform: identity.platform,
        handle: identity.handle,
        displayName: identity.name,
        evidence: [`fact:${factId}`],
        confidence: metadata.confidence ?? 0.7,
        suggestedType: "person",
      });
      identityCount += 1;
    }
    if (edges.length > 0) {
      const result = await applyExtractedEdges({
        entityStore,
        relationshipStore,
        evidenceId: `fact:${factId}`,
        edges,
        source: "extraction",
      });
      relationshipCount = result.relationships.length;
    }
  }

  await markFactBridged(runtime, factId);
  return {
    skipped: false,
    ownerFactKeys,
    identityCount,
    relationshipCount,
  };
}

export function registerCoreFactMemoryBridge(runtime: IAgentRuntime): void {
  runtime.registerPipelineHook({
    id: "lifeops:core-fact-memory-bridge",
    phase: "after_memory_persisted",
    schedule: "serial",
    mutatesPrimary: false,
    async handler(hookRuntime, ctx) {
      if (ctx.phase !== "after_memory_persisted" || ctx.tableName !== "facts") {
        return;
      }
      try {
        await bridgeCoreFactMemory(hookRuntime, ctx.memory, {
          memoryId: ctx.memoryId,
        });
      } catch (error) {
        // error-policy:J7 diagnostics-must-not-kill-the-loop — fact projection
        // failures must surface without aborting the original memory write.
        hookRuntime.reportError("CoreFactMemoryBridge", error, {
          memoryId: ctx.memoryId,
          tableName: ctx.tableName,
        });
      }
    },
  });
}
