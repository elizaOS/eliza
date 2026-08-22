/**
 * Private authenticated ingress for person-link attestations. The transport
 * derives the operator principal and role from its trusted boundary; request
 * bodies cannot claim confirmation, verification, actor, or authority fields.
 */
import {
  ElizaError,
  type IdentityPersonLinkActorRole,
  IdentityResolutionService,
  type Route,
  type RouteHandlerContext,
  type RouteHandlerResult,
  type UUID,
  validateUuid,
} from "@elizaos/core";
import { computeIdentityPersonLinkRequestDigest } from "../services/sql-identity-resolution";

const ATTEST_PATH = "/api/identity/person-links/attest";
const VERIFY_PATH = "/api/identity/person-links/verify";
const ATTEST_FIELDS = new Set([
  "leftPrincipalId",
  "rightPrincipalId",
  "expectedGeneration",
  "reason",
  "idempotencyKey",
]);

function json(status: number, body: unknown): RouteHandlerResult {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function expectedGeneration(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function queryValue(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function authenticatedActor(
  ctx: RouteHandlerContext
): { principalId: UUID; role: IdentityPersonLinkActorRole } | RouteHandlerResult {
  if (!ctx.accessContext) {
    return json(403, { error: "IDENTITY_PERSON_LINK_AUTHORITY_REQUIRED" });
  }
  const role = ctx.accessContext.role;
  if (role !== "OWNER" && role !== "ADMIN") {
    return json(403, { error: "IDENTITY_PERSON_LINK_AUTHORITY_REQUIRED" });
  }
  return { principalId: ctx.accessContext.requesterEntityId, role };
}

function identityFailure(ctx: RouteHandlerContext, error: unknown): RouteHandlerResult {
  if (error instanceof ElizaError) {
    const conflictCodes = new Set([
      "IDENTITY_GENERATION_CONFLICT",
      "IDENTITY_IDEMPOTENCY_CONFLICT",
      "IDENTITY_PERSON_LINK_ALREADY_CANONICAL",
    ]);
    const notFound = error.code === "IDENTITY_PRINCIPAL_NOT_FOUND";
    return json(notFound ? 404 : conflictCodes.has(error.code) ? 409 : 400, {
      error: error.code,
      message: error.message,
    });
  }
  // error-policy:J1 route boundary translation — unexpected authority or SQL
  // failures are reported and returned as explicit failure, never success.
  ctx.runtime.reportError("identity-person-link-route", error, { path: ctx.path });
  return json(500, { error: "IDENTITY_PERSON_LINK_FAILED" });
}

async function attest(ctx: RouteHandlerContext): Promise<RouteHandlerResult> {
  const body = record(ctx.body);
  if (!body || Object.keys(body).some((key) => !ATTEST_FIELDS.has(key))) {
    return json(400, { error: "IDENTITY_PERSON_LINK_INPUT_INVALID" });
  }
  const leftPrincipalId = validateUuid(body.leftPrincipalId);
  const rightPrincipalId = validateUuid(body.rightPrincipalId);
  const generation = expectedGeneration(body.expectedGeneration);
  const reason = requiredString(body.reason, 500);
  const idempotencyKey = requiredString(body.idempotencyKey, 200);
  if (!leftPrincipalId || !rightPrincipalId || generation === null || !reason || !idempotencyKey) {
    return json(400, { error: "IDENTITY_PERSON_LINK_INPUT_INVALID" });
  }
  const actor = authenticatedActor(ctx);
  if ("status" in actor) return actor;
  const service = ctx.runtime.getService<IdentityResolutionService>(
    IdentityResolutionService.serviceType
  );
  if (!service) return json(503, { error: "IDENTITY_AUTHORITY_UNAVAILABLE" });
  const requestWithoutDigest = {
    agentId: ctx.runtime.agentId,
    leftPrincipalId,
    rightPrincipalId,
    actorPrincipalId: actor.principalId,
    actorRole: actor.role,
    authority: "authenticated_private_route" as const,
    transport: ctx.inProcess ? ("in_process" as const) : ("http" as const),
    reason,
    idempotencyKey,
    expectedGeneration: generation,
  };
  try {
    const attestation = await service.attestPersonLink({
      ...requestWithoutDigest,
      requestDigest: computeIdentityPersonLinkRequestDigest(requestWithoutDigest),
    });
    return json(201, { attestation });
  } catch (error) {
    return identityFailure(ctx, error);
  }
}

async function verify(ctx: RouteHandlerContext): Promise<RouteHandlerResult> {
  const actor = authenticatedActor(ctx);
  if ("status" in actor) return actor;
  const leftPrincipalId = validateUuid(queryValue(ctx.query.leftPrincipalId));
  const rightPrincipalId = validateUuid(queryValue(ctx.query.rightPrincipalId));
  const generationText = queryValue(ctx.query.expectedGeneration);
  const generation = generationText === null ? null : expectedGeneration(Number(generationText));
  if (!leftPrincipalId || !rightPrincipalId || generation === null) {
    return json(400, { error: "IDENTITY_PERSON_LINK_INPUT_INVALID" });
  }
  const service = ctx.runtime.getService<IdentityResolutionService>(
    IdentityResolutionService.serviceType
  );
  if (!service) return json(503, { error: "IDENTITY_AUTHORITY_UNAVAILABLE" });
  try {
    const verification = await service.verifyPersonLink({
      agentId: ctx.runtime.agentId,
      leftPrincipalId,
      rightPrincipalId,
      expectedGeneration: generation,
    });
    return json(200, { verification });
  } catch (error) {
    return identityFailure(ctx, error);
  }
}

export const identityPersonLinkRoutes: readonly Route[] = [
  {
    name: "identity-person-link-attest",
    path: ATTEST_PATH,
    type: "POST",
    public: false,
    routeHandler: attest,
  },
  {
    name: "identity-person-link-verify",
    path: VERIFY_PATH,
    type: "GET",
    public: false,
    routeHandler: verify,
  },
];
