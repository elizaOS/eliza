/**
 * Owner-authorized HTTP contract for parenting-agreement versions, reviews,
 * pins, and bounded guest grants. The handler translates typed domain failures
 * into stable JSON errors while all authorization remains in the domain
 * service rather than request-provided role headers.
 */

import { SELF_ENTITY_ID } from "@elizaos/shared";
import {
  AgreementKnowledgeError,
  getAgreementKnowledgeService,
} from "../lifeops/household/agreement-knowledge.js";
import {
  agreementUploadSizeMessage,
  MAX_AGREEMENT_PDF_BYTES,
} from "../lifeops/household/agreement-upload-limits.js";
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

function decodeAgreementPdf(bytesBase64: string): Buffer {
  if (
    bytesBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(bytesBase64)
  ) {
    throw new AgreementKnowledgeError(
      "bytesBase64 must be canonical base64",
      "AGREEMENT_INVALID_CONTRACT",
      { field: "bytesBase64" },
    );
  }
  const paddingBytes = bytesBase64.endsWith("==")
    ? 2
    : bytesBase64.endsWith("=")
      ? 1
      : 0;
  const decodedBytes = (bytesBase64.length / 4) * 3 - paddingBytes;
  if (decodedBytes > MAX_AGREEMENT_PDF_BYTES) {
    throw new AgreementKnowledgeError(
      agreementUploadSizeMessage(),
      "AGREEMENT_INVALID_CONTRACT",
      { maxBytes: MAX_AGREEMENT_PDF_BYTES, decodedBytes },
    );
  }
  const bytes = Buffer.from(bytesBase64, "base64");
  if (bytes.toString("base64") !== bytesBase64) {
    throw new AgreementKnowledgeError(
      "bytesBase64 must be canonical base64",
      "AGREEMENT_INVALID_CONTRACT",
      { field: "bytesBase64" },
    );
  }
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new AgreementKnowledgeError(
      "Parenting agreement bytes do not have a PDF signature",
      "AGREEMENT_INVALID_CONTRACT",
    );
  }
  return bytes;
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
  if (!ctx.pathname.startsWith("/api/lifeops/agreements")) return false;
  const runtime = ctx.state.runtime;
  const service = runtime ? getAgreementKnowledgeService(runtime) : null;
  if (!service) {
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

    if (ctx.method === "POST" && ctx.pathname === "/api/lifeops/agreements") {
      const body = record(await ctx.readJsonBody(ctx.req));
      const bytesBase64 = stringField(body, "bytesBase64");
      const bytes = decodeAgreementPdf(bytesBase64);
      const artifact = await service.createAgreementVersion({
        householdId: optionalString(body, "householdId"),
        agreementKey: stringField(body, "agreementKey"),
        title: stringField(body, "title"),
        originalFilename: stringField(body, "originalFilename"),
        mimeType: stringField(body, "mimeType"),
        bytes,
        pageCount: numberField(body, "pageCount"),
        uploadedByEntityId: SELF_ENTITY_ID,
      });
      ctx.json(ctx.res, { artifact }, 201);
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
      const body = record(await ctx.readJsonBody(ctx.req));
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
      const body = record(await ctx.readJsonBody(ctx.req));
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
      const body = record(await ctx.readJsonBody(ctx.req));
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
      const body = record(await ctx.readJsonBody(ctx.req));
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
      const body = record(await ctx.readJsonBody(ctx.req));
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
      const body = record(await ctx.readJsonBody(ctx.req));
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
