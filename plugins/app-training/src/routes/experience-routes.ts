/**
 * Experience HTTP routes.
 *
 * Migrated from `packages/agent/src/api/experience-routes.ts` so the experience
 * service surface lives next to the rest of the training/trajectory plumbing.
 *
 * The runtime mounts these routes through the plugin route registry; see
 * `setup-routes.ts` for the registered Plugin and the `rawPath: true` paths.
 */

import type { AgentRuntime, UUID } from "@elizaos/core";
import type { RouteRequestContext } from "@elizaos/shared";

// These enums and types are defined in @elizaos/core's advanced-capabilities
// experience module but not re-exported from the compiled dist bundle (tsdown
// tree-shakes them). Inlined here so the packaged desktop build works without
// a cross-package source import.
enum ExperienceType {
  SUCCESS = "success",
  FAILURE = "failure",
  DISCOVERY = "discovery",
  CORRECTION = "correction",
  LEARNING = "learning",
  HYPOTHESIS = "hypothesis",
  VALIDATION = "validation",
  WARNING = "warning",
}

enum OutcomeType {
  POSITIVE = "positive",
  NEGATIVE = "negative",
  NEUTRAL = "neutral",
  MIXED = "mixed",
}

interface Experience {
  id: UUID;
  agentId: UUID;
  type: ExperienceType;
  outcome: OutcomeType;
  context: string;
  action: string;
  result: string;
  learning: string;
  tags: string[];
  domain: string;
  keywords: string[];
  associatedEntityIds: UUID[];
  relatedExperiences?: UUID[];
  supersedes?: UUID;
  mergedExperienceIds?: UUID[];
  confidence: number;
  importance: number;
  createdAt?: number;
  updatedAt: number;
  lastAccessedAt?: number;
  accessCount: number;
  previousBelief?: string;
  correctedBelief?: string;
  embedding?: number[];
  memoryIds?: UUID[];
  sourceMessageIds?: UUID[];
  sourceRoomId?: UUID;
  sourceTriggerMessageId?: UUID;
  sourceTrajectoryId?: string;
  sourceTrajectoryStepId?: string;
  extractionMethod?: string;
  extractionReason?: string;
}

interface ExperienceQuery {
  query?: string;
  type?: ExperienceType | ExperienceType[];
  outcome?: OutcomeType | OutcomeType[];
  domain?: string | string[];
  tags?: string[];
  minImportance?: number;
  minConfidence?: number;
  timeRange?: {
    start?: number;
    end?: number;
  };
  limit?: number;
  includeRelated?: boolean;
}

interface ExperienceService {
  recordExperience(experienceData: Partial<Experience>): Promise<Experience>;
  listExperiences(query?: ExperienceQuery): Promise<Experience[]>;
  getExperience(id: UUID): Promise<Experience | null>;
  updateExperience(
    id: UUID,
    updates: Partial<Experience>,
  ): Promise<Experience | null>;
  deleteExperience(id: UUID): Promise<boolean>;
  getExperienceGraph(query?: ExperienceQuery): Promise<unknown>;
  consolidateDuplicateExperiences(options?: {
    deleteDuplicates?: boolean;
    limit?: number;
  }): Promise<unknown>;
}

const EXPERIENCE_ROUTE_PREFIXES = [
  "/api/experiences",
  "/api/character/experiences",
] as const;
const EXPERIENCE_LIST_DEFAULT_LIMIT = 100;
const EXPERIENCE_LIST_MAX_LIMIT = 200;

type ExperienceMutationBody = Record<string, unknown>;

type ExperienceMutationInput = Partial<Experience>;

type ExperienceResponse = Omit<Experience, "embedding"> & {
  embeddingDimensions?: number;
};

export interface ExperienceRouteContext extends RouteRequestContext {
  runtime: AgentRuntime | null;
  url: URL;
}

function isExperienceService(service: unknown): service is ExperienceService {
  if (!service || typeof service !== "object") {
    return false;
  }
  const candidate = service as Record<string, unknown>;
  const requiredMethods = [
    "recordExperience",
    "listExperiences",
    "getExperience",
    "updateExperience",
    "deleteExperience",
    "getExperienceGraph",
    "consolidateDuplicateExperiences",
  ];
  return requiredMethods.every(
    (method) => typeof candidate[method] === "function",
  );
}

function getExperienceService(
  runtime: AgentRuntime | null,
): ExperienceService | null {
  const service = runtime?.getService("EXPERIENCE");
  return isExperienceService(service) ? service : null;
}

function matchExperiencePath(pathname: string): {
  basePath: (typeof EXPERIENCE_ROUTE_PREFIXES)[number];
  suffix: string;
} | null {
  for (const basePath of EXPERIENCE_ROUTE_PREFIXES) {
    if (pathname === basePath || pathname.startsWith(`${basePath}/`)) {
      return {
        basePath,
        suffix: pathname.slice(basePath.length),
      };
    }
  }

  return null;
}

function parseCsvSearchParams(url: URL, key: string): string[] | undefined {
  const values = url.searchParams
    .getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return values.length > 0 ? values : undefined;
}

function parseNumberParam(
  value: string | null,
  field: string,
): { value?: number; error?: string } {
  if (value == null || value.trim().length === 0) {
    return {};
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { error: `${field} must be a number.` };
  }

  return { value: parsed };
}

function parseLimit(url: URL): { value: number; error?: string } {
  const rawLimit = url.searchParams.get("limit");
  if (!rawLimit) {
    return { value: EXPERIENCE_LIST_DEFAULT_LIMIT };
  }

  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return {
      value: EXPERIENCE_LIST_DEFAULT_LIMIT,
      error: "limit must be a positive integer.",
    };
  }

  return {
    value: Math.min(parsed, EXPERIENCE_LIST_MAX_LIMIT),
  };
}

function parseBooleanParam(value: string | null): boolean | undefined {
  if (value == null || value.trim().length === 0) {
    return undefined;
  }

  return value === "1" || value.toLowerCase() === "true";
}

function parseEnumValue<T extends string>(
  value: unknown,
  validValues: readonly T[],
  field: string,
): { value?: T; error?: string } {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string" || !validValues.includes(value as T)) {
    return {
      error: `${field} must be one of: ${validValues.join(", ")}.`,
    };
  }
  return { value: value as T };
}

function parseStringField(
  value: unknown,
  field: string,
  options?: { allowNull?: boolean },
): { value?: string; error?: string; clear?: true } {
  if (value === undefined) {
    return {};
  }
  if (value === null && options?.allowNull) {
    return { clear: true };
  }
  if (typeof value !== "string") {
    return { error: `${field} must be a string.` };
  }
  return { value };
}

function parseStringArrayField(
  value: unknown,
  field: string,
): { value?: string[]; error?: string } {
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return { error: `${field} must be an array of strings.` };
  }
  return { value: [...value] };
}

function parseScoreField(
  value: unknown,
  field: string,
): { value?: number; error?: string } {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { error: `${field} must be a number.` };
  }
  if (value < 0 || value > 1) {
    return { error: `${field} must be between 0 and 1.` };
  }
  return { value };
}

function parseExperienceMutationBody(
  body: ExperienceMutationBody,
  mode: "create" | "update",
): { data?: ExperienceMutationInput; error?: string } {
  const parsed: ExperienceMutationInput = {};

  const type = parseEnumValue(body.type, Object.values(ExperienceType), "type");
  if (type.error) return { error: type.error };
  if (type.value !== undefined) {
    parsed.type = type.value;
  }

  const outcome = parseEnumValue(
    body.outcome,
    Object.values(OutcomeType),
    "outcome",
  );
  if (outcome.error) return { error: outcome.error };
  if (outcome.value !== undefined) {
    parsed.outcome = outcome.value;
  }

  const context = parseStringField(body.context, "context");
  if (context.error) return { error: context.error };
  if ("value" in context) {
    parsed.context = context.value ?? "";
  }

  const action = parseStringField(body.action, "action");
  if (action.error) return { error: action.error };
  if ("value" in action) {
    parsed.action = action.value ?? "";
  }

  const result = parseStringField(body.result, "result");
  if (result.error) return { error: result.error };
  if ("value" in result) {
    parsed.result = result.value ?? "";
  }

  const learning = parseStringField(body.learning, "learning");
  if (learning.error) return { error: learning.error };
  if ("value" in learning) {
    parsed.learning = learning.value ?? "";
  }

  const domain = parseStringField(body.domain, "domain");
  if (domain.error) return { error: domain.error };
  if ("value" in domain) {
    parsed.domain = domain.value ?? "";
  }

  const tags = parseStringArrayField(body.tags, "tags");
  if (tags.error) return { error: tags.error };
  if (tags.value !== undefined) {
    parsed.tags = tags.value;
  }

  const keywords = parseStringArrayField(body.keywords, "keywords");
  if (keywords.error) return { error: keywords.error };
  if (keywords.value !== undefined) {
    parsed.keywords = keywords.value;
  }

  const associatedEntityIds = parseStringArrayField(
    body.associatedEntityIds,
    "associatedEntityIds",
  );
  if (associatedEntityIds.error) return { error: associatedEntityIds.error };
  if (associatedEntityIds.value !== undefined) {
    parsed.associatedEntityIds = associatedEntityIds.value as UUID[];
  }

  const relatedExperiences = parseStringArrayField(
    body.relatedExperiences,
    "relatedExperiences",
  );
  if (relatedExperiences.error) return { error: relatedExperiences.error };
  if (relatedExperiences.value !== undefined) {
    parsed.relatedExperiences = relatedExperiences.value as UUID[];
  }

  const mergedExperienceIds = parseStringArrayField(
    body.mergedExperienceIds,
    "mergedExperienceIds",
  );
  if (mergedExperienceIds.error) return { error: mergedExperienceIds.error };
  if (mergedExperienceIds.value !== undefined) {
    parsed.mergedExperienceIds = mergedExperienceIds.value as UUID[];
  }

  const confidence = parseScoreField(body.confidence, "confidence");
  if (confidence.error) return { error: confidence.error };
  if (confidence.value !== undefined) {
    parsed.confidence = confidence.value;
  }

  const importance = parseScoreField(body.importance, "importance");
  if (importance.error) return { error: importance.error };
  if (importance.value !== undefined) {
    parsed.importance = importance.value;
  }

  const supersedes = parseStringField(body.supersedes, "supersedes", {
    allowNull: true,
  });
  if (supersedes.error) return { error: supersedes.error };
  if (supersedes.clear) {
    parsed.supersedes = undefined;
  } else if (supersedes.value !== undefined) {
    parsed.supersedes = supersedes.value as UUID;
  }

  const previousBelief = parseStringField(
    body.previousBelief,
    "previousBelief",
    { allowNull: true },
  );
  if (previousBelief.error) return { error: previousBelief.error };
  if (previousBelief.clear) {
    parsed.previousBelief = undefined;
  } else if (previousBelief.value !== undefined) {
    parsed.previousBelief = previousBelief.value;
  }

  const correctedBelief = parseStringField(
    body.correctedBelief,
    "correctedBelief",
    { allowNull: true },
  );
  if (correctedBelief.error) return { error: correctedBelief.error };
  if (correctedBelief.clear) {
    parsed.correctedBelief = undefined;
  } else if (correctedBelief.value !== undefined) {
    parsed.correctedBelief = correctedBelief.value;
  }

  if (mode === "create" && !parsed.learning?.trim()) {
    return { error: "learning is required." };
  }

  if (mode === "update" && Object.keys(parsed).length === 0) {
    return { error: "At least one editable field is required." };
  }

  return { data: parsed };
}

function parseExperienceQuery(url: URL): {
  query?: ExperienceQuery;
  error?: string;
} {
  const limit = parseLimit(url);
  if (limit.error) {
    return { error: limit.error };
  }

  const minConfidence = parseNumberParam(
    url.searchParams.get("minConfidence"),
    "minConfidence",
  );
  if (minConfidence.error) {
    return { error: minConfidence.error };
  }

  const minImportance = parseNumberParam(
    url.searchParams.get("minImportance"),
    "minImportance",
  );
  if (minImportance.error) {
    return { error: minImportance.error };
  }

  const start = parseNumberParam(url.searchParams.get("start"), "start");
  if (start.error) {
    return { error: start.error };
  }

  const end = parseNumberParam(url.searchParams.get("end"), "end");
  if (end.error) {
    return { error: end.error };
  }

  const type = parseCsvSearchParams(url, "type");
  const invalidType = type?.find(
    (value) => !Object.values(ExperienceType).includes(value as ExperienceType),
  );
  if (invalidType) {
    return {
      error: `type must be one of: ${Object.values(ExperienceType).join(", ")}.`,
    };
  }

  const outcome = parseCsvSearchParams(url, "outcome");
  const invalidOutcome = outcome?.find(
    (value) => !Object.values(OutcomeType).includes(value as OutcomeType),
  );
  if (invalidOutcome) {
    return {
      error: `outcome must be one of: ${Object.values(OutcomeType).join(", ")}.`,
    };
  }

  const domain = parseCsvSearchParams(url, "domain");
  const tags =
    parseCsvSearchParams(url, "tag") ?? parseCsvSearchParams(url, "tags");
  const includeRelated = parseBooleanParam(
    url.searchParams.get("includeRelated"),
  );

  return {
    query: {
      query:
        url.searchParams.get("q") ?? url.searchParams.get("query") ?? undefined,
      type:
        type && type.length === 1
          ? (type[0] as ExperienceType)
          : (type as ExperienceType[] | undefined),
      outcome:
        outcome && outcome.length === 1
          ? (outcome[0] as OutcomeType)
          : (outcome as OutcomeType[] | undefined),
      domain: domain && domain.length === 1 ? domain[0] : domain,
      tags,
      minConfidence: minConfidence.value,
      minImportance: minImportance.value,
      timeRange:
        start.value !== undefined || end.value !== undefined
          ? {
              start: start.value,
              end: end.value,
            }
          : undefined,
      limit: limit.value,
      includeRelated,
    },
  };
}

function toExperienceResponse(experience: Experience): ExperienceResponse {
  const { embedding: _embedding, ...rest } = experience;
  return {
    ...rest,
    tags: [...experience.tags],
    keywords: [...experience.keywords],
    associatedEntityIds: [...experience.associatedEntityIds],
    embeddingDimensions: experience.embedding?.length,
    relatedExperiences: experience.relatedExperiences
      ? [...experience.relatedExperiences]
      : undefined,
    mergedExperienceIds: experience.mergedExperienceIds
      ? [...experience.mergedExperienceIds]
      : undefined,
  };
}

export async function handleExperienceRoutes(
  ctx: ExperienceRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    runtime,
    url,
    json,
    error,
    readJsonBody,
  } = ctx;
  const matchedPath = matchExperiencePath(pathname);
  if (!matchedPath) {
    return false;
  }

  if (!runtime) {
    error(res, "Agent runtime not available. Start the agent first.", 503);
    return true;
  }

  const experienceService = getExperienceService(runtime);
  if (!experienceService) {
    error(
      res,
      "Experience service is not available. Make sure advanced capabilities are enabled.",
      503,
    );
    return true;
  }

  if (matchedPath.suffix === "") {
    if (method === "GET") {
      const parsedQuery = parseExperienceQuery(url);
      if (parsedQuery.error) {
        error(res, parsedQuery.error, 400);
        return true;
      }

      const experiences = await experienceService.listExperiences(
        parsedQuery.query,
      );
      json(
        res,
        {
          data: experiences.map(toExperienceResponse),
          total: experiences.length,
        },
        200,
      );
      return true;
    }

    if (method === "POST") {
      const body = await readJsonBody<ExperienceMutationBody>(req, res);
      if (!body) {
        return true;
      }

      const parsedBody = parseExperienceMutationBody(body, "create");
      if (parsedBody.error) {
        error(res, parsedBody.error, 400);
        return true;
      }

      const experience = await experienceService.recordExperience(
        parsedBody.data ?? {},
      );
      json(res, { data: toExperienceResponse(experience) }, 201);
      return true;
    }

    error(res, "Method not allowed.", 405);
    return true;
  }

  if (matchedPath.suffix === "/graph") {
    if (method !== "GET") {
      error(res, "Method not allowed.", 405);
      return true;
    }

    const parsedQuery = parseExperienceQuery(url);
    if (parsedQuery.error) {
      error(res, parsedQuery.error, 400);
      return true;
    }

    const graph = await experienceService.getExperienceGraph(parsedQuery.query);
    json(res, { data: graph }, 200);
    return true;
  }

  if (matchedPath.suffix === "/maintenance") {
    if (method !== "POST") {
      error(res, "Method not allowed.", 405);
      return true;
    }

    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) {
      return true;
    }

    const limit =
      typeof body.limit === "number" && Number.isFinite(body.limit)
        ? Math.max(
            1,
            Math.min(EXPERIENCE_LIST_MAX_LIMIT, Math.floor(body.limit)),
          )
        : undefined;
    const result = await experienceService.consolidateDuplicateExperiences({
      deleteDuplicates: body.deleteDuplicates === true,
      limit,
    });
    json(res, { data: result }, 200);
    return true;
  }

  const experienceId =
    matchedPath.suffix.startsWith("/") &&
    matchedPath.suffix.slice(1).length > 0 &&
    !matchedPath.suffix.slice(1).includes("/")
      ? (decodeURIComponent(matchedPath.suffix.slice(1)) as UUID)
      : null;
  if (!experienceId) {
    error(res, "Experience not found.", 404);
    return true;
  }

  if (method === "GET") {
    const experience = await experienceService.getExperience(experienceId);
    if (!experience) {
      error(res, "Experience not found.", 404);
      return true;
    }

    json(res, { data: toExperienceResponse(experience) }, 200);
    return true;
  }

  if (method === "PUT" || method === "PATCH") {
    const body = await readJsonBody<ExperienceMutationBody>(req, res);
    if (!body) {
      return true;
    }

    const parsedBody = parseExperienceMutationBody(body, "update");
    if (parsedBody.error) {
      error(res, parsedBody.error, 400);
      return true;
    }

    const experience = await experienceService.updateExperience(
      experienceId,
      parsedBody.data ?? {},
    );
    if (!experience) {
      error(res, "Experience not found.", 404);
      return true;
    }

    json(res, { data: toExperienceResponse(experience) }, 200);
    return true;
  }

  if (method === "DELETE") {
    const deleted = await experienceService.deleteExperience(experienceId);
    if (!deleted) {
      error(res, "Experience not found.", 404);
      return true;
    }

    json(res, { ok: true, id: experienceId }, 200);
    return true;
  }

  error(res, "Method not allowed.", 405);
  return true;
}

export const EXPERIENCE_ROUTE_PATHS: Array<{ type: string; path: string }> = [
  { type: "GET", path: "/api/experiences" },
  { type: "POST", path: "/api/experiences" },
  { type: "GET", path: "/api/experiences/graph" },
  { type: "POST", path: "/api/experiences/maintenance" },
  { type: "GET", path: "/api/experiences/:experienceId" },
  { type: "PUT", path: "/api/experiences/:experienceId" },
  { type: "PATCH", path: "/api/experiences/:experienceId" },
  { type: "DELETE", path: "/api/experiences/:experienceId" },
  { type: "GET", path: "/api/character/experiences" },
  { type: "POST", path: "/api/character/experiences" },
  { type: "GET", path: "/api/character/experiences/graph" },
  { type: "POST", path: "/api/character/experiences/maintenance" },
  { type: "GET", path: "/api/character/experiences/:experienceId" },
  { type: "PUT", path: "/api/character/experiences/:experienceId" },
  { type: "PATCH", path: "/api/character/experiences/:experienceId" },
  { type: "DELETE", path: "/api/character/experiences/:experienceId" },
];
