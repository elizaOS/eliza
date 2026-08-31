/**
 * Direct route-boundary tests for the agreement owner surface. The domain
 * service is replaced only to force typed failure/output cases; routing,
 * owner actor selection, and machine-readable HTTP translation are real.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { AgreementKnowledgeError } from "../lifeops/household/agreement-knowledge.js";
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
