import type {
  IAgentRuntime,
  RelationshipsGraphQuery,
  RelationshipsGraphService,
  RelationshipsMergeProposalEvidence,
  UUID,
} from "@elizaos/core";
import type { RouteRequestContext } from "@elizaos/shared";
import { PostRelationshipLinkRequestSchema } from "@elizaos/shared";

type RelationshipsFeatureRuntime = IAgentRuntime & {
  enableRelationships?: () => Promise<void>;
  isRelationshipsEnabled?: () => boolean;
};

export interface RelationshipsRouteContext extends RouteRequestContext {
  runtime?: IAgentRuntime | null;
}

// The merged RelationshipsService (in @elizaos/core) implements the
// RelationshipsGraphService surface directly.
type RelationshipsServiceWithGraph = RelationshipsGraphService;

function isRelationshipsServiceWithGraph(
  service: unknown,
): service is RelationshipsServiceWithGraph {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as { getGraphSnapshot?: unknown }).getGraphSnapshot ===
      "function" &&
    typeof (service as { getPersonDetail?: unknown }).getPersonDetail ===
      "function" &&
    typeof (service as { getCandidateMerges?: unknown }).getCandidateMerges ===
      "function" &&
    typeof (service as { acceptMerge?: unknown }).acceptMerge === "function" &&
    typeof (service as { rejectMerge?: unknown }).rejectMerge === "function"
  );
}

function parseQuery(reqUrl: string | undefined): RelationshipsGraphQuery {
  const url = new URL(reqUrl ?? "/api/relationships/graph", "http://localhost");
  const parseInteger = (
    value: string | null,
    options?: { min?: number },
  ): number | undefined => {
    if (!value) {
      return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    if (typeof options?.min === "number" && parsed < options.min) {
      return undefined;
    }
    return parsed;
  };
  const scopeParam = url.searchParams.get("scope");
  const scope =
    scopeParam === "relevant" || scopeParam === "all" ? scopeParam : undefined;

  return {
    search: url.searchParams.get("search"),
    platform: url.searchParams.get("platform"),
    limit: parseInteger(url.searchParams.get("limit"), { min: 1 }),
    offset: parseInteger(url.searchParams.get("offset"), { min: 0 }),
    scope,
  };
}

async function getRelationshipsGraphService(
  runtime?: IAgentRuntime | null,
): Promise<RelationshipsServiceWithGraph | null> {
  if (!runtime) {
    return null;
  }

  const runtimeWithFeatures = runtime as RelationshipsFeatureRuntime;
  if (
    typeof runtimeWithFeatures.isRelationshipsEnabled === "function" &&
    !runtimeWithFeatures.isRelationshipsEnabled() &&
    typeof runtimeWithFeatures.enableRelationships === "function"
  ) {
    await runtimeWithFeatures.enableRelationships();
  }

  const service = runtime.getService("relationships");
  return isRelationshipsServiceWithGraph(service) ? service : null;
}

function asEvidenceRecord(value: unknown): RelationshipsMergeProposalEvidence {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  try {
    return JSON.parse(
      JSON.stringify(value),
    ) as RelationshipsMergeProposalEvidence;
  } catch {
    return {};
  }
}

function parseActivityInteger(
  value: string | null,
  fallback: number,
  options: { min: number; max?: number },
): number | null {
  if (value === null) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < options.min) {
    return null;
  }
  return typeof options.max === "number"
    ? Math.min(parsed, options.max)
    : parsed;
}

export async function handleRelationshipsRoutes(
  ctx: RelationshipsRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, json, error, readJsonBody, runtime } =
    ctx;

  const isCandidatesRoute =
    pathname === "/api/relationships/candidates" ||
    pathname.startsWith("/api/relationships/candidates/");
  const isPersonLinkRoute =
    pathname.startsWith("/api/relationships/people/") &&
    pathname.endsWith("/link");

  if (
    pathname !== "/api/relationships/graph" &&
    pathname !== "/api/relationships/people" &&
    pathname !== "/api/relationships/activity" &&
    !pathname.startsWith("/api/relationships/people/") &&
    !isCandidatesRoute
  ) {
    return false;
  }

  // GET routes go through the read paths below; merge/link mutations are
  // POST-only and handled before the GET-only fast-fail.
  if (method !== "GET" && method !== "POST") {
    return false;
  }

  const relationshipsGraph = await getRelationshipsGraphService(runtime);
  if (!relationshipsGraph) {
    error(
      res,
      "Relationships graph service is not available. Make sure the native relationships feature is enabled.",
      503,
    );
    return true;
  }

  if (method === "POST") {
    if (pathname === "/api/relationships/candidates") {
      // Read-only on this exact pathname; POST is reserved for nested IDs.
      error(res, "Method not allowed.", 405);
      return true;
    }

    if (
      pathname.startsWith("/api/relationships/candidates/") &&
      (pathname.endsWith("/accept") || pathname.endsWith("/reject"))
    ) {
      const action = pathname.endsWith("/accept") ? "accept" : "reject";
      const idStart = "/api/relationships/candidates/".length;
      const idEnd = pathname.lastIndexOf("/");
      const candidateId = decodeURIComponent(pathname.slice(idStart, idEnd));
      if (!candidateId) {
        error(res, "Missing merge candidate id.", 400);
        return true;
      }
      if (action === "accept") {
        await relationshipsGraph.acceptMerge(candidateId as UUID);
      } else {
        await relationshipsGraph.rejectMerge(candidateId as UUID);
      }
      json(res, { data: { id: candidateId, status: action } }, 200);
      return true;
    }

    if (isPersonLinkRoute) {
      const idStart = "/api/relationships/people/".length;
      const idEnd = pathname.lastIndexOf("/");
      const sourceEntityId = decodeURIComponent(pathname.slice(idStart, idEnd));
      if (!sourceEntityId) {
        error(res, "Missing source entity id.", 400);
        return true;
      }
      const rawLink = await readJsonBody<Record<string, unknown>>(req, res);
      if (rawLink === null) return true;
      const parsedLink = PostRelationshipLinkRequestSchema.safeParse(rawLink);
      if (!parsedLink.success) {
        error(
          res,
          parsedLink.error.issues[0]?.message ?? "targetEntityId is required.",
          400,
        );
        return true;
      }
      const evidence = asEvidenceRecord(parsedLink.data.evidence);
      const candidateId = await relationshipsGraph.proposeMerge(
        sourceEntityId as UUID,
        parsedLink.data.targetEntityId as UUID,
        evidence,
      );
      json(res, { data: { id: candidateId, status: "pending" } }, 201);
      return true;
    }

    error(res, "Method not allowed.", 405);
    return true;
  }

  if (method === "GET" && pathname === "/api/relationships/candidates") {
    const candidates = await relationshipsGraph.getCandidateMerges();
    json(res, { data: candidates }, 200);
    return true;
  }

  if (pathname === "/api/relationships/graph") {
    const snapshot = await relationshipsGraph.getGraphSnapshot(
      parseQuery(req.url),
    );
    json(res, { data: snapshot }, 200);
    return true;
  }

  if (pathname === "/api/relationships/people") {
    const snapshot = await relationshipsGraph.getGraphSnapshot(
      parseQuery(req.url),
    );
    json(
      res,
      {
        data: snapshot.people,
        stats: snapshot.stats,
      },
      200,
    );
    return true;
  }

  if (pathname === "/api/relationships/activity") {
    const snapshot = await relationshipsGraph.getGraphSnapshot();
    type ActivityItem = {
      type: "relationship" | "identity" | "fact";
      personName: string;
      personId: string;
      summary: string;
      detail: string | null;
      timestamp: string | null;
    };
    const activity: ActivityItem[] = [];
    const personByEntityId = new Map<
      string,
      { personId: string; personName: string }
    >();

    for (const person of snapshot.people) {
      personByEntityId.set(person.primaryEntityId, {
        personId: person.primaryEntityId,
        personName: person.displayName,
      });
      for (const memberEntityId of person.memberEntityIds) {
        personByEntityId.set(memberEntityId, {
          personId: person.primaryEntityId,
          personName: person.displayName,
        });
      }
    }

    for (const edge of snapshot.relationships) {
      const types = edge.relationshipTypes.join(", ") || "connected";
      activity.push({
        type: "relationship",
        personName: edge.sourcePersonName,
        personId: edge.sourcePersonId,
        summary: `${edge.sourcePersonName} ↔ ${edge.targetPersonName}`,
        detail: `${types} · ${edge.sentiment} · strength ${edge.strength.toFixed(2)} · ${edge.interactionCount} interactions`,
        timestamp: edge.lastInteractionAt ?? null,
      });
    }

    for (const person of snapshot.people) {
      const platforms = person.platforms.join(", ") || "no platform";
      activity.push({
        type: "identity",
        personName: person.displayName,
        personId: person.primaryEntityId,
        summary: person.displayName,
        detail: `${person.memberEntityIds.length} identit${person.memberEntityIds.length === 1 ? "y" : "ies"} on ${platforms} · ${person.factCount} facts`,
        timestamp: person.lastInteractionAt ?? null,
      });
    }

    if (runtime) {
      const recentFacts = await runtime.getMemories({
        agentId: runtime.agentId,
        tableName: "facts",
        limit: 200,
      });
      for (const fact of recentFacts) {
        const text =
          typeof fact.content?.text === "string"
            ? fact.content.text.trim()
            : "";
        if (!text) {
          continue;
        }
        const person = fact.entityId
          ? (personByEntityId.get(fact.entityId) ?? null)
          : null;
        const metadata =
          fact.metadata && typeof fact.metadata === "object"
            ? (fact.metadata as Record<string, unknown>)
            : null;
        const confidence =
          typeof metadata?.confidence === "number" ? metadata.confidence : null;
        const scopeBase =
          metadata?.base && typeof metadata.base === "object"
            ? (metadata.base as Record<string, unknown>)
            : null;
        const scope =
          typeof scopeBase?.scope === "string" ? scopeBase.scope : null;
        const detailParts = [text];
        if (scope) {
          detailParts.push(scope);
        }
        if (confidence !== null) {
          detailParts.push(`confidence ${confidence.toFixed(2)}`);
        }
        activity.push({
          type: "fact",
          personName: person?.personName ?? "Unknown person",
          personId: person?.personId ?? fact.entityId ?? "unknown",
          summary: person?.personName
            ? `Fact for ${person.personName}`
            : "Fact extracted",
          detail: detailParts.join(" · "),
          timestamp:
            typeof fact.createdAt === "number"
              ? new Date(fact.createdAt).toISOString()
              : null,
        });
      }
    }

    activity.sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
      return tb - ta;
    });

    const activityUrl = new URL(
      req.url ?? "/api/relationships/activity",
      "http://localhost",
    );
    const limit = parseActivityInteger(
      activityUrl.searchParams.get("limit"),
      50,
      { min: 1, max: 100 },
    );
    const offset = parseActivityInteger(
      activityUrl.searchParams.get("offset"),
      0,
      { min: 0 },
    );
    if (limit === null || offset === null) {
      error(res, "Invalid relationships activity pagination.", 400);
      return true;
    }

    json(
      res,
      {
        activity: activity.slice(offset, offset + limit),
        total: activity.length,
        count: Math.max(0, Math.min(limit, activity.length - offset)),
        offset,
        limit,
        hasMore: offset + limit < activity.length,
      },
      200,
    );
    return true;
  }

  const primaryEntityId = decodeURIComponent(
    pathname.slice("/api/relationships/people/".length),
  );
  if (!primaryEntityId) {
    error(res, "Missing relationships person identifier.", 400);
    return true;
  }

  const detail = await relationshipsGraph.getPersonDetail(
    primaryEntityId as UUID,
  );
  if (!detail) {
    error(res, "Relationships person not found.", 404);
    return true;
  }

  json(res, { data: detail }, 200);
  return true;
}
