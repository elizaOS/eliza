/**
 * Owner-authorized HTTP contract for parenting-agreement versions, reviews,
 * pins, and bounded guest grants. The handler translates typed domain failures
 * into stable JSON errors while all authorization remains in the domain
 * service rather than request-provided role headers.
 */

import { readRequestBodyBuffer } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import {
  AgreementKnowledgeError,
  getAgreementKnowledgeService,
  type ParentingAgreementArtifact,
} from "../lifeops/household/agreement-knowledge.js";
import {
  AGREEMENT_UPLOAD_CHUNK_BYTES,
  AGREEMENT_UPLOAD_METADATA_BYTES,
} from "../lifeops/household/agreement-upload-limits.js";
import {
  acceptAgreementChunk,
  agreementUploadView,
  beginAgreementUpload,
  commitAgreementUpload,
  readAgreementUpload,
} from "../lifeops/household/agreement-upload-session.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgreementKnowledgeError(
      "Request body must be a JSON object",
      "AGREEMENT_INVALID_CONTRACT",
    );
  }
  return value as JsonObject;
}

function stringField(body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new AgreementKnowledgeError(
      `${field} is required`,
      "AGREEMENT_INVALID_CONTRACT",
      { field },
    );
  }
  return value.trim();
}

function numberField(body: JsonObject, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AgreementKnowledgeError(
      `${field} must be an integer`,
      "AGREEMENT_INVALID_CONTRACT",
      { field },
    );
  }
  return value;
}

function optionalString(body: JsonObject, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pathMatch(pathname: string, expression: RegExp): string[] | null {
  const match = expression.exec(pathname);
  if (!match) return null;
  return match.slice(1).map((part) => decodeURIComponent(part ?? ""));
}

function statusFor(error: AgreementKnowledgeError): number {
  switch (error.code) {
    case "AGREEMENT_ACCESS_DENIED":
      return 403;
    case "AGREEMENT_ARTIFACT_NOT_FOUND":
      return 404;
    case "AGREEMENT_OBLIGATION_CONFLICT":
    case "AGREEMENT_DUPLICATE_CONTENT":
      return 409;
    case "AGREEMENT_STORAGE_UNAVAILABLE":
      return 503;
    default:
      return 400;
  }
}

export async function handleAgreementKnowledgeRoutes(
  ctx: LifeOpsRouteContext,
): Promise<boolean> {
  if (
    !ctx.pathname.startsWith("/api/lifeops/agreements") &&
    !ctx.pathname.startsWith("/api/lifeops/agreement-uploads")
  ) {
    return false;
  }
  const runtime = ctx.state.runtime;
  const service = runtime ? getAgreementKnowledgeService(runtime) : null;
  if (!runtime || !service) {
    ctx.json(
      ctx.res,
      {
        error: {
          code: "AGREEMENT_STORAGE_UNAVAILABLE",
          message: "Agreement knowledge service is unavailable",
        },
      },
      503,
    );
    return true;
  }

  try {
    if (ctx.method === "GET" && ctx.pathname === "/api/lifeops/agreements") {
      const agreements = await service.listOwnerAgreements({
        ownerEntityId: SELF_ENTITY_ID,
        householdId: ctx.url.searchParams.get("householdId") ?? undefined,
      });
      ctx.json(ctx.res, { agreements });
      return true;
    }

    if (
      ctx.method === "POST" &&
      ctx.pathname === "/api/lifeops/agreement-uploads"
    ) {
      const body = record(
        await ctx.readJsonBody(ctx.req, ctx.res, {
          maxBytes: AGREEMENT_UPLOAD_METADATA_BYTES,
        }),
      );
      const manifest = await beginAgreementUpload(runtime, {
        agreementKey: stringField(body, "agreementKey"),
        title: stringField(body, "title"),
        originalFilename: stringField(body, "originalFilename"),
        mimeType: stringField(body, "mimeType"),
        sizeBytes: numberField(body, "sizeBytes"),
      });
      ctx.json(ctx.res, { upload: agreementUploadView(manifest) }, 201);
      return true;
    }

    const uploadStatus = pathMatch(
      ctx.pathname,
      /^\/api\/lifeops\/agreement-uploads\/([^/]+)$/,
    );
    if (ctx.method === "GET" && uploadStatus) {
      const manifest = await readAgreementUpload(
        runtime,
        uploadStatus[0] ?? "",
      );
      ctx.json(ctx.res, { upload: agreementUploadView(manifest) });
      return true;
    }

    const uploadChunk = pathMatch(
      ctx.pathname,
      /^\/api\/lifeops\/agreement-uploads\/([^/]+)\/chunks\/(\d+)$/,
    );
    if (ctx.method === "PUT" && uploadChunk) {
      const bytes = await readRequestBodyBuffer(ctx.req, {
        maxBytes: AGREEMENT_UPLOAD_CHUNK_BYTES,
      });
      if (!bytes) {
        throw new AgreementKnowledgeError(
          "Agreement chunk body is required",
          "AGREEMENT_INVALID_CONTRACT",
        );
      }
      const shaHeader = ctx.req.headers["x-chunk-sha256"];
      const sha256 = Array.isArray(shaHeader) ? shaHeader[0] : shaHeader;
      if (!sha256) {
        throw new AgreementKnowledgeError(
          "X-Chunk-Sha256 is required",
          "AGREEMENT_INVALID_CONTRACT",
        );
      }
      const manifest = await acceptAgreementChunk({
        runtime,
        uploadId: uploadChunk[0] ?? "",
        index: Number(uploadChunk[1]),
        bytes,
        sha256,
      });
      ctx.json(ctx.res, { upload: agreementUploadView(manifest) });
      return true;
    }

    const uploadCommit = pathMatch(
      ctx.pathname,
      /^\/api\/lifeops\/agreement-uploads\/([^/]+)\/commit$/,
    );
    if (ctx.method === "POST" && uploadCommit) {
      const body = record(
        (await ctx.readJsonBody(ctx.req, ctx.res, {
          maxBytes: AGREEMENT_UPLOAD_METADATA_BYTES,
        })) ?? {},
      );
      const committed = await commitAgreementUpload<ParentingAgreementArtifact>(
        {
          runtime,
          uploadId: uploadCommit[0] ?? "",
          contentIdentity: stringField(body, "contentIdentity"),
          expectedSha256: optionalString(body, "sha256"),
          createArtifact: async ({ manifest, bytes }) => {
            return await service.createAgreementVersion({
              agreementKey: manifest.agreementKey,
              title: manifest.title,
              originalFilename: manifest.originalFilename,
              mimeType: manifest.mimeType,
              bytes,
              uploadedByEntityId: SELF_ENTITY_ID,
            });
          },
          readArtifact: async (artifactId) => {
            const existing = await service.readFor({
              artifactId,
              principalEntityId: SELF_ENTITY_ID,
            });
            return existing.artifact as ParentingAgreementArtifact;
          },
        },
      );
      ctx.json(
        ctx.res,
        { artifact: committed.artifact },
        committed.created ? 201 : 200,
      );
      return true;
    }

    const artifactDownload = pathMatch(
      ctx.pathname,
      /^\/api\/lifeops\/agreements\/([^/]+)\/download$/,
    );
    if (ctx.method === "GET" && artifactDownload) {
      const file = await service.readOwnerPdf({
        artifactId: artifactDownload[0] ?? "",
        ownerEntityId: SELF_ENTITY_ID,
      });
      ctx.res.statusCode = 200;
      ctx.res.setHeader("Content-Type", file.mimeType);
      ctx.res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      );
      ctx.res.setHeader("Content-Length", String(file.bytes.length));
      ctx.res.end(file.bytes);
      return true;
    }

    const artifactRead = pathMatch(
      ctx.pathname,
      /^\/api\/lifeops\/agreements\/([^/]+)$/,
    );
    if (ctx.method === "GET" && artifactRead) {
      const agreement = await service.readFor({
        artifactId: artifactRead[0] ?? "",
        principalEntityId: SELF_ENTITY_ID,
      });
      ctx.json(ctx.res, { agreement });
      return true;
    }

    const guestProjection = pathMatch(
      ctx.pathname,
      /^\/api\/lifeops\/agreements\/([^/]+)\/guest-projection$/,
    );
    if (ctx.method === "GET" && guestProjection) {
      const principalEntityId = ctx.url.searchParams.get("principalEntityId");
      if (!principalEntityId) {
        throw new AgreementKnowledgeError(
          "principalEntityId is required",
          "AGREEMENT_INVALID_CONTRACT",
          { field: "principalEntityId" },
        );
      }
      const agreement = await service.readFor({
        artifactId: guestProjection[0] ?? "",
        principalEntityId,
      });
      ctx.json(ctx.res, { agreement });
      return true;
    }

    const obligationCreate = pathMatch(
      ctx.pathname,
      /^\/api\/lifeops\/agreements\/([^/]+)\/obligations$/,
    );
    if (ctx.method === "POST" && obligationCreate) {
      const body = record(await ctx.readJsonBody(ctx.req, ctx.res));
      const obligation = await service.proposeObligation({
        artifactId: obligationCreate[0] ?? "",
        title: stringField(body, "title"),
        obligationText: stringField(body, "obligationText"),
        pageStart: numberField(body, "pageStart"),
        pageEnd:
          typeof body.pageEnd === "number"
            ? numberField(body, "pageEnd")
            : undefined,
        citationText: stringField(body, "citationText"),
        proposedByEntityId: SELF_ENTITY_ID,
      });
      ctx.json(ctx.res, { obligation }, 201);
      return true;
    }

    const decision = pathMatch(
      ctx.pathname,
      /^\/api\/lifeops\/agreements\/obligations\/([^/]+)\/decision$/,
    );
    if (ctx.method === "POST" && decision) {
      const body = record(await ctx.readJsonBody(ctx.req, ctx.res));
      const requestedDecision = stringField(body, "decision");
      if (requestedDecision !== "approve" && requestedDecision !== "reject") {
        throw new AgreementKnowledgeError(
          "decision must be approve or reject",
          "AGREEMENT_INVALID_CONTRACT",
          { decision: requestedDecision },
        );
      }
      const obligation = await service.decideObligation({
        obligationId: decision[0] ?? "",
        decision: requestedDecision,
        decidedByEntityId: SELF_ENTITY_ID,
        reason: stringField(body, "reason"),
      });
      ctx.json(ctx.res, { obligation });
      return true;
    }

    const pins = pathMatch(
      ctx.pathname,
      /^\/api\/lifeops\/agreements\/([^/]+)\/pins$/,
    );
    if (pins && ctx.method === "GET") {
      const result = await service.listPins({
        artifactId: pins[0] ?? "",
        ownerEntityId: SELF_ENTITY_ID,
      });
      ctx.json(ctx.res, { pins: result });
      return true;
    }
    if (pins && ctx.method === "POST") {
      const body = record(await ctx.readJsonBody(ctx.req, ctx.res));
      const targetType = stringField(body, "targetType");
      if (targetType !== "agent" && targetType !== "chat") {
        throw new AgreementKnowledgeError(
          "targetType must be agent or chat",
          "AGREEMENT_INVALID_CONTRACT",
          { targetType },
        );
      }
      const pin = await service.pin({
        artifactId: pins[0] ?? "",
        targetType,
        targetId: stringField(body, "targetId"),
        pinnedByEntityId: SELF_ENTITY_ID,
      });
      ctx.json(ctx.res, { pin }, 201);
      return true;
    }

    const unpin = pathMatch(
      ctx.pathname,
      /^\/api\/lifeops\/agreements\/pins\/([^/]+)$/,
    );
    if (ctx.method === "DELETE" && unpin) {
      const pin = await service.unpin({
        pinId: unpin[0] ?? "",
        unpinnedByEntityId: SELF_ENTITY_ID,
      });
      ctx.json(ctx.res, { pin });
      return true;
    }

    if (
      ctx.method === "POST" &&
      ctx.pathname === "/api/lifeops/agreements/grants/preview"
    ) {
      const body = record(await ctx.readJsonBody(ctx.req, ctx.res));
      const preview = await service.previewGuestRead({
        artifactId: stringField(body, "artifactId"),
        principalEntityId: stringField(body, "principalEntityId"),
        householdGrantId: stringField(body, "householdGrantId"),
        ownerEntityId: SELF_ENTITY_ID,
      });
      ctx.json(ctx.res, { preview });
      return true;
    }

    if (
      ctx.method === "POST" &&
      ctx.pathname === "/api/lifeops/agreements/grants"
    ) {
      const body = record(await ctx.readJsonBody(ctx.req, ctx.res));
      const grant = await service.grantGuestRead({
        artifactId: stringField(body, "artifactId"),
        principalEntityId: stringField(body, "principalEntityId"),
        householdGrantId: stringField(body, "householdGrantId"),
        issuedByEntityId: SELF_ENTITY_ID,
      });
      ctx.json(ctx.res, { grant }, 201);
      return true;
    }

    const revoke = pathMatch(
      ctx.pathname,
      /^\/api\/lifeops\/agreements\/grants\/([^/]+)\/revoke$/,
    );
    if (ctx.method === "POST" && revoke) {
      const body = record(await ctx.readJsonBody(ctx.req, ctx.res));
      const grant = await service.revokeGuestRead({
        grantId: revoke[0] ?? "",
        revokedByEntityId: SELF_ENTITY_ID,
        reason: stringField(body, "reason"),
      });
      ctx.json(ctx.res, { grant });
      return true;
    }

    ctx.json(
      ctx.res,
      {
        error: {
          code: "AGREEMENT_ROUTE_NOT_FOUND",
          message: "Agreement route not found",
        },
      },
      404,
    );
    return true;
  } catch (error) {
    if (error instanceof AgreementKnowledgeError) {
      ctx.json(
        ctx.res,
        {
          error: {
            code: error.code,
            message: error.message,
            context: error.context,
          },
        },
        statusFor(error),
      );
      return true;
    }
    // error-policy:J1 The HTTP boundary preserves an explicit unavailable
    // state while unexpected failures remain visible to runtime diagnostics.
    runtime?.reportError?.("lifeops.agreementRoutes", error);
    ctx.json(
      ctx.res,
      {
        error: {
          code: "AGREEMENT_INTERNAL_ERROR",
          message: "Agreement request failed",
        },
      },
      500,
    );
    return true;
  }
}
