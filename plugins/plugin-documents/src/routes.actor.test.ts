/**
 * Comprehensive security unit tests for document store route actor resolution
 * and process-private principal authorization (Requirement 8).
 *
 * Verifies that:
 * - Public headers alone CANNOT mint OWNER, AGENT, or USER authority.
 * - Missing/unauthenticated requests return null (triggering 401 Unauthorized).
 * - Forged identity headers are ignored.
 * - Process-private AccessContext is required to receive permissions.
 * - User/owner-private documents cannot be accessed anonymously.
 */

import type { UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveRouteActor } from "./routes.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const USER_ID = "00000000-0000-0000-0000-000000000003" as UUID;

function fakeReq(headers: Record<string, string | undefined> = {}) {
  return { headers } as unknown as Parameters<typeof resolveRouteActor>[0];
}

describe("resolveRouteActor process-private principal authorization", () => {
  it("returns null (triggering 401) for unauthenticated headerless requests", () => {
    const actor = resolveRouteActor(fakeReq({}), AGENT_ID, OWNER_ID);
    expect(actor).toBeNull();
  });

  it("ignores forged public identity headers without authenticated AccessContext", () => {
    const forgedOwner = resolveRouteActor(
      fakeReq({ "x-eliza-entity-id": OWNER_ID }),
      AGENT_ID,
      OWNER_ID,
    );
    expect(forgedOwner).toBeNull();

    const forgedAgent = resolveRouteActor(
      fakeReq({ "x-eliza-entity-id": AGENT_ID }),
      AGENT_ID,
      OWNER_ID,
    );
    expect(forgedAgent).toBeNull();
  });

  it("grants OWNER permissions when authenticated via process-private AccessContext", () => {
    const actor = resolveRouteActor(fakeReq({}), AGENT_ID, OWNER_ID, {
      authenticated: true,
      role: "OWNER",
      entityId: OWNER_ID,
    });
    expect(actor).not.toBeNull();
    expect(actor?.role).toBe("OWNER");
    expect(actor?.entityId).toBe(OWNER_ID);
  });

  it("grants AGENT permissions when authenticated via process-private AccessContext", () => {
    const actor = resolveRouteActor(fakeReq({}), AGENT_ID, OWNER_ID, {
      authenticated: true,
      role: "AGENT",
      entityId: AGENT_ID,
    });
    expect(actor).not.toBeNull();
    expect(actor?.role).toBe("AGENT");
    expect(actor?.entityId).toBe(AGENT_ID);
  });

  it("grants USER permissions when authenticated via process-private AccessContext", () => {
    const actor = resolveRouteActor(fakeReq({}), AGENT_ID, OWNER_ID, {
      authenticated: true,
      role: "USER",
      entityId: USER_ID,
    });
    expect(actor).not.toBeNull();
    expect(actor?.role).toBe("USER");
    expect(actor?.entityId).toBe(USER_ID);
    expect(actor?.entityId).not.toBe(OWNER_ID);
  });

  it("rejects explicitly unauthenticated AccessContext with null", () => {
    const actor = resolveRouteActor(fakeReq({}), AGENT_ID, OWNER_ID, {
      authenticated: false,
    });
    expect(actor).toBeNull();
  });
});
