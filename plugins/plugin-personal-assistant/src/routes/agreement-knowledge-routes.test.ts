/**
 * Direct route-boundary tests for the agreement owner surface. The domain
 * service is replaced only to force typed failure/output cases; routing,
 * owner actor selection, and machine-readable HTTP translation are real.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { AgreementKnowledgeError } from "../lifeops/household/agreement-knowledge.js";
import {
  MAX_AGREEMENT_PDF_BYTES,
  MAX_AGREEMENT_UPLOAD_JSON_BYTES,
} from "../lifeops/household/agreement-upload-limits.js";
import { handleAgreementKnowledgeRoutes } from "./agreement-knowledge-routes.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

function context(input: {
  method: string;
  pathname: string;
  body?: unknown;
  agreements: Record<string, unknown>;
}) {
  const responses: Array<{ data: unknown; status: number }> = [];
  const runtime = {
    getService: vi.fn(() => ({ agreements: input.agreements })),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  const ctx = {
    req: {},
    res: {},
    method: input.method,
    pathname: input.pathname,
    url: new URL(`http://localhost${input.pathname}`),
    state: { runtime, adminEntityId: "self" },
    json: (_res: unknown, data: unknown, status = 200) => {
      responses.push({ data, status });
    },
    error: vi.fn(),
    readJsonBody: vi.fn(async () => input.body),
    decodePathComponent: decodeURIComponent,
  } as unknown as LifeOpsRouteContext;
  return { ctx, responses, runtime };
}

describe("agreement knowledge routes", () => {
  it("creates an immutable PDF version from the owner upload contract", async () => {
    const artifact = { id: "artifact-1", version: 1 };
    const createAgreementVersion = vi.fn(async () => artifact);
    const harness = context({
      method: "POST",
      pathname: "/api/lifeops/agreements",
      body: {
        agreementKey: "parenting-plan",
        title: "Parenting agreement",
        originalFilename: "agreement.pdf",
        mimeType: "application/pdf",
        pageCount: 14,
        bytesBase64: Buffer.from("%PDF-1.7").toString("base64"),
      },
      agreements: { createAgreementVersion },
    });

    await expect(handleAgreementKnowledgeRoutes(harness.ctx)).resolves.toBe(
      true,
    );
    expect(createAgreementVersion).toHaveBeenCalledWith({
      householdId: undefined,
      agreementKey: "parenting-plan",
      title: "Parenting agreement",
      originalFilename: "agreement.pdf",
      mimeType: "application/pdf",
      pageCount: 14,
      bytes: Buffer.from("%PDF-1.7"),
      uploadedByEntityId: "self",
    });
    expect(harness.responses).toEqual([{ status: 201, data: { artifact } }]);
  });

  it("accepts agreement PDF bytes above the default 1 MiB transport cap", async () => {
    const createAgreementVersion = vi.fn(async () => ({
      id: "artifact-large",
    }));
    const bytes = Buffer.alloc(1024 * 1024 + 1, 0x61);
    bytes.write("%PDF-", 0, "ascii");
    const harness = context({
      method: "POST",
      pathname: "/api/lifeops/agreements",
      body: {
        agreementKey: "parenting-plan",
        title: "Parenting agreement",
        originalFilename: "agreement.pdf",
        mimeType: "application/pdf",
        pageCount: 14,
        bytesBase64: bytes.toString("base64"),
      },
      agreements: { createAgreementVersion },
    });

    await expect(handleAgreementKnowledgeRoutes(harness.ctx)).resolves.toBe(
      true,
    );
    expect(harness.ctx.readJsonBody).toHaveBeenCalledWith(
      harness.ctx.req,
      harness.ctx.res,
      { maxBytes: MAX_AGREEMENT_UPLOAD_JSON_BYTES },
    );
    expect(harness.responses[0]?.status).toBe(201);
    const call = createAgreementVersion.mock.calls[0]?.[0] as {
      bytes: Buffer;
    };
    expect(call.bytes.byteLength).toBe(bytes.byteLength);
    expect(call.bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("rejects oversized or non-PDF decoded bytes before storage", async () => {
    const createAgreementVersion = vi.fn();
    const oversized = Buffer.alloc(MAX_AGREEMENT_PDF_BYTES + 1, 0x61);
    oversized.write("%PDF-", 0, "ascii");
    const tooLarge = context({
      method: "POST",
      pathname: "/api/lifeops/agreements",
      body: {
        agreementKey: "parenting-plan",
        title: "Parenting agreement",
        originalFilename: "agreement.pdf",
        mimeType: "application/pdf",
        pageCount: 14,
        bytesBase64: oversized.toString("base64"),
      },
      agreements: { createAgreementVersion },
    });
    await handleAgreementKnowledgeRoutes(tooLarge.ctx);
    expect(tooLarge.responses).toEqual([
      expect.objectContaining({
        status: 400,
        data: expect.objectContaining({
          error: expect.objectContaining({
            code: "AGREEMENT_INVALID_CONTRACT",
            context: expect.objectContaining({
              maxBytes: MAX_AGREEMENT_PDF_BYTES,
            }),
          }),
        }),
      }),
    ]);

    const badSignature = context({
      method: "POST",
      pathname: "/api/lifeops/agreements",
      body: {
        agreementKey: "parenting-plan",
        title: "Parenting agreement",
        originalFilename: "agreement.pdf",
        mimeType: "application/pdf",
        pageCount: 14,
        bytesBase64: Buffer.from("not-a-pdf").toString("base64"),
      },
      agreements: { createAgreementVersion },
    });
    await handleAgreementKnowledgeRoutes(badSignature.ctx);
    expect(badSignature.responses[0]).toMatchObject({
      status: 400,
      data: {
        error: {
          code: "AGREEMENT_INVALID_CONTRACT",
          message: "Parenting agreement bytes do not have a PDF signature",
        },
      },
    });
    expect(createAgreementVersion).not.toHaveBeenCalled();
  });

  it("returns a stable forbidden error when the domain denies the read", async () => {
    const readFor = vi.fn(async () => {
      throw new AgreementKnowledgeError(
        "The principal has no active grant",
        "AGREEMENT_ACCESS_DENIED",
        { artifactId: "artifact-1" },
      );
    });
    const harness = context({
      method: "GET",
      pathname: "/api/lifeops/agreements/artifact-1",
      agreements: { readFor },
    });
    await expect(handleAgreementKnowledgeRoutes(harness.ctx)).resolves.toBe(
      true,
    );
    expect(harness.responses).toEqual([
      {
        status: 403,
        data: {
          error: {
            code: "AGREEMENT_ACCESS_DENIED",
            message: "The principal has no active grant",
            context: { artifactId: "artifact-1" },
          },
        },
      },
    ]);
  });

  it("returns explicit grant effects and exclusions without issuing a grant", async () => {
    const previewGuestRead = vi.fn(async () => ({
      allowed: false,
      artifactId: "artifact-1",
      principalEntityId: "guest-1",
      householdGrantId: "household-grant-1",
      effects: ["read_artifact_metadata", "read_approved_obligations"],
      exclusions: [
        "read_proposed_or_rejected_obligations",
        "mutate_agreement",
        "inherit_access_from_pin",
      ],
      denial: {
        code: "AGREEMENT_ACCESS_DENIED",
        message: "Guest requires a verified identity",
      },
    }));
    const harness = context({
      method: "POST",
      pathname: "/api/lifeops/agreements/grants/preview",
      body: {
        artifactId: "artifact-1",
        principalEntityId: "guest-1",
        householdGrantId: "household-grant-1",
      },
      agreements: { previewGuestRead },
    });
    await handleAgreementKnowledgeRoutes(harness.ctx);
    expect(previewGuestRead).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      principalEntityId: "guest-1",
      householdGrantId: "household-grant-1",
      ownerEntityId: "self",
    });
    expect(harness.responses[0]).toMatchObject({
      status: 200,
      data: {
        preview: {
          allowed: false,
          exclusions: [
            "read_proposed_or_rejected_obligations",
            "mutate_agreement",
            "inherit_access_from_pin",
          ],
        },
      },
    });
  });
});
