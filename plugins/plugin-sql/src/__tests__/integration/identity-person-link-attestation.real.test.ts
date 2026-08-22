/**
 * Exercises authenticated person-link ingress against a real migrated PGlite
 * authority, including stale generations, forged fields, replay, and proof
 * that attestations never create redirects or merge journals.
 */
import { IdentityResolutionService, type RouteHandlerContext, type UUID } from "@elizaos/core";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { identityPersonLinkRoutes } from "../../routes/identity-person-link";
import { entityTable } from "../../schema/entity";
import {
  identityAuthorityStateTable,
  identityCanonicalRedirectTable,
  identityMergeJournalTable,
  identityPersonLinkAttestationTable,
} from "../../schema/identityAuthority";
import { SqlIdentityResolutionService } from "../../services/sql-identity-resolution";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

const actorId = crypto.randomUUID() as UUID;
const leftId = crypto.randomUUID() as UUID;
const rightId = crypto.randomUUID() as UUID;
const otherLeftId = crypto.randomUUID() as UUID;
const otherRightId = crypto.randomUUID() as UUID;

describe.sequential("authenticated identity person-link ingress", () => {
  let cleanup: () => Promise<void>;
  let db: DrizzleDatabase;
  let runtime: Awaited<ReturnType<typeof createIsolatedTestDatabase>>["runtime"];
  let service: SqlIdentityResolutionService;
  let agentId: UUID;

  const attestRoute = identityPersonLinkRoutes.find(
    (route) => route.name === "identity-person-link-attest"
  );
  const verifyRoute = identityPersonLinkRoutes.find(
    (route) => route.name === "identity-person-link-verify"
  );

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("identity-person-link-attestation-real");
    cleanup = setup.cleanup;
    db = setup.adapter.getDatabase() as DrizzleDatabase;
    runtime = setup.runtime;
    agentId = setup.testAgentId;
    service = new SqlIdentityResolutionService(runtime);
    vi.spyOn(runtime, "getService").mockImplementation((type) =>
      type === IdentityResolutionService.serviceType ? service : null
    );
    await db.insert(entityTable).values(
      [actorId, leftId, rightId, otherLeftId, otherRightId].map((id) => ({
        id,
        agentId,
        names: [id],
        metadata: {},
      }))
    );
  });

  afterAll(async () => {
    await cleanup?.();
  });

  function context(args: {
    body?: unknown;
    query?: Record<string, string>;
    role?: "OWNER" | "ADMIN" | "USER";
  }): RouteHandlerContext {
    return {
      body: args.body,
      params: {},
      query: args.query ?? {},
      headers: {},
      method: args.query ? "GET" : "POST",
      path: args.query ? "/api/identity/person-links/verify" : "/api/identity/person-links/attest",
      runtime,
      inProcess: false,
      ...(args.role
        ? {
            accessContext: {
              requesterEntityId: actorId,
              role: args.role,
              isOwner: args.role === "OWNER",
            },
          }
        : {}),
    };
  }

  it("persists server-derived ADMIN evidence and verifies it at the committed generation", async () => {
    expect(attestRoute).toMatchObject({ type: "POST", public: false });
    expect(verifyRoute).toMatchObject({ type: "GET", public: false });
    if (!attestRoute?.routeHandler || !verifyRoute?.routeHandler) throw new Error("routes missing");

    const body = {
      leftPrincipalId: rightId,
      rightPrincipalId: leftId,
      expectedGeneration: 0,
      reason: "Operator checked both authenticated accounts",
      idempotencyKey: "person-link-admin-1",
    };
    const created = await attestRoute.routeHandler(context({ body, role: "ADMIN" }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      attestation: {
        actorPrincipalId: actorId,
        actorRole: "ADMIN",
        authority: "authenticated_private_route",
        transport: "http",
        expectedGeneration: 0,
        committedGeneration: 1,
      },
    });

    const rows = await db.select().from(identityPersonLinkAttestationTable);
    expect(rows).toHaveLength(1);
    const persisted = rows[0];
    if (!persisted) throw new Error("attestation missing");
    expect(persisted).toMatchObject({
      leftPrincipalId: [leftId, rightId].sort()[0],
      rightPrincipalId: [leftId, rightId].sort()[1],
      actorPrincipalId: actorId,
      actorRole: "ADMIN",
      expectedGeneration: 0,
      committedGeneration: 1,
    });
    expect(await db.select().from(identityCanonicalRedirectTable)).toHaveLength(0);
    expect(await db.select().from(identityMergeJournalTable)).toHaveLength(0);
    const updateError = await db
      .update(identityPersonLinkAttestationTable)
      .set({ reason: "tampered" })
      .where(eq(identityPersonLinkAttestationTable.id, persisted.id))
      .then(
        () => null,
        (error: unknown) => error
      );
    const deleteError = await db
      .delete(identityPersonLinkAttestationTable)
      .where(eq(identityPersonLinkAttestationTable.id, persisted.id))
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(updateError).toHaveProperty("cause.code", "55000");
    expect(deleteError).toHaveProperty("cause.code", "55000");

    const verified = await verifyRoute.routeHandler(
      context({
        role: "OWNER",
        query: {
          leftPrincipalId: leftId,
          rightPrincipalId: rightId,
          expectedGeneration: "1",
        },
      })
    );
    expect(verified).toMatchObject({
      status: 200,
      body: {
        verification: {
          decision: "attested",
          generation: 1,
          attestation: { actorRole: "ADMIN", committedGeneration: 1 },
        },
      },
    });
    const staleVerification = await verifyRoute.routeHandler(
      context({
        role: "OWNER",
        query: {
          leftPrincipalId: leftId,
          rightPrincipalId: rightId,
          expectedGeneration: "0",
        },
      })
    );
    expect(staleVerification).toMatchObject({
      status: 409,
      body: { error: "IDENTITY_GENERATION_CONFLICT" },
    });

    const replayed = await attestRoute.routeHandler(context({ body, role: "ADMIN" }));
    expect(replayed).toEqual(created);
    expect(await db.select().from(identityPersonLinkAttestationTable)).toHaveLength(1);
  });

  it("rejects model-shaped authority fields and non-admin users before mutation", async () => {
    if (!attestRoute?.routeHandler) throw new Error("attest route missing");
    const [before] = await db.select().from(identityAuthorityStateTable);
    const beforeCount = await db
      .select({ value: count() })
      .from(identityPersonLinkAttestationTable);
    const forged = await attestRoute.routeHandler(
      context({
        role: "OWNER",
        body: {
          leftPrincipalId: otherLeftId,
          rightPrincipalId: otherRightId,
          expectedGeneration: 1,
          reason: "model says same person",
          idempotencyKey: "forged-authority",
          confirmed: true,
          verified: true,
          actorRole: "OWNER",
        },
      })
    );
    expect(forged).toMatchObject({
      status: 400,
      body: { error: "IDENTITY_PERSON_LINK_INPUT_INVALID" },
    });
    const ordinaryUser = await attestRoute.routeHandler(
      context({
        role: "USER",
        body: {
          leftPrincipalId: otherLeftId,
          rightPrincipalId: otherRightId,
          expectedGeneration: 1,
          reason: "not authorized",
          idempotencyKey: "ordinary-user",
        },
      })
    );
    expect(ordinaryUser).toMatchObject({
      status: 403,
      body: { error: "IDENTITY_PERSON_LINK_AUTHORITY_REQUIRED" },
    });
    const [after] = await db.select().from(identityAuthorityStateTable);
    const afterCount = await db.select({ value: count() }).from(identityPersonLinkAttestationTable);
    expect(after?.generation).toBe(before?.generation);
    expect(afterCount[0]?.value).toBe(beforeCount[0]?.value);
  });

  it("rejects a missing access context before service or database access", async () => {
    if (!attestRoute?.routeHandler) throw new Error("attest route missing");
    const attestSpy = vi.spyOn(service, "attestPersonLink");
    const callsBefore = attestSpy.mock.calls.length;
    const [before] = await db.select().from(identityAuthorityStateTable);
    const beforeCount = await db
      .select({ value: count() })
      .from(identityPersonLinkAttestationTable);
    const missingContext = await attestRoute.routeHandler(
      context({
        body: {
          leftPrincipalId: otherLeftId,
          rightPrincipalId: otherRightId,
          expectedGeneration: 1,
          reason: "must not inherit configured owner",
          idempotencyKey: "missing-access-context",
        },
      })
    );
    expect(missingContext).toMatchObject({
      status: 403,
      body: { error: "IDENTITY_PERSON_LINK_AUTHORITY_REQUIRED" },
    });
    expect(attestSpy.mock.calls).toHaveLength(callsBefore);
    const [after] = await db.select().from(identityAuthorityStateTable);
    const afterCount = await db.select({ value: count() }).from(identityPersonLinkAttestationTable);
    expect(after?.generation).toBe(before?.generation);
    expect(afterCount[0]?.value).toBe(beforeCount[0]?.value);
  });

  it("allows exactly one concurrent attestation at a generation and leaves no merge artifacts", async () => {
    if (!attestRoute?.routeHandler) throw new Error("attest route missing");
    const request = (leftPrincipalId: UUID, rightPrincipalId: UUID, idempotencyKey: string) =>
      attestRoute.routeHandler?.(
        context({
          role: "OWNER",
          body: {
            leftPrincipalId,
            rightPrincipalId,
            expectedGeneration: 1,
            reason: "concurrent operator decision",
            idempotencyKey,
          },
        })
      );
    const outcomes = await Promise.all([
      request(otherLeftId, otherRightId, "generation-race-left"),
      request(leftId, otherLeftId, "generation-race-right"),
    ]);
    expect(outcomes.map((result) => result?.status).sort()).toEqual([201, 409]);
    const [state] = await db
      .select()
      .from(identityAuthorityStateTable)
      .where(eq(identityAuthorityStateTable.agentId, agentId));
    expect(state?.generation).toBe(2);
    expect(await db.select().from(identityPersonLinkAttestationTable)).toHaveLength(2);
    expect(await db.select().from(identityCanonicalRedirectTable)).toHaveLength(0);
    expect(await db.select().from(identityMergeJournalTable)).toHaveLength(0);
  });
});
