/**
 * Comprehensive security unit tests for document store route actor resolution
 * and process-private principal authorization (Requirement 8).
 *
 * Verifies that:
 * - Missing AccessContext fails closed without minting a route actor.
 * - AccessContext with requesterEntityId resolves to the correct RouteActor.
 * - OWNER, ADMIN, USER, and GUEST remain distinct.
 * - Missing requesterEntityId returns null.
 */

import type { AccessContext, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveRouteActor } from "./routes.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const USER_ID = "00000000-0000-0000-0000-000000000003" as UUID;

describe("resolveRouteActor process-private principal authorization", () => {
  it.each([OWNER_ID, undefined])(
    "fails closed without AccessContext when ownerEntityId is %s",
    (ownerEntityId) => {
      expect(resolveRouteActor(AGENT_ID, ownerEntityId)).toBeNull();
    },
  );

  it("grants OWNER permissions for OWNER AccessContext role", () => {
    const actor = resolveRouteActor(AGENT_ID, OWNER_ID, {
      requesterEntityId: OWNER_ID,
      role: "OWNER",
      isOwner: true,
    } satisfies AccessContext);
    expect(actor).not.toBeNull();
    expect(actor?.role).toBe("OWNER");
    expect(actor?.entityId).toBe(OWNER_ID);
  });

  it("preserves ADMIN without granting OWNER permissions", () => {
    const actor = resolveRouteActor(AGENT_ID, OWNER_ID, {
      requesterEntityId: OWNER_ID,
      role: "ADMIN",
    } satisfies AccessContext);
    expect(actor).not.toBeNull();
    expect(actor?.role).toBe("ADMIN");
  });

  it("grants USER permissions for USER AccessContext role", () => {
    const actor = resolveRouteActor(AGENT_ID, OWNER_ID, {
      requesterEntityId: USER_ID,
      role: "USER",
    } satisfies AccessContext);
    expect(actor).not.toBeNull();
    expect(actor?.role).toBe("USER");
    expect(actor?.entityId).toBe(USER_ID);
    expect(actor?.entityId).not.toBe(OWNER_ID);
  });

  it("preserves GUEST without granting USER permissions", () => {
    const actor = resolveRouteActor(AGENT_ID, OWNER_ID, {
      requesterEntityId: USER_ID,
      role: "GUEST",
    } satisfies AccessContext);
    expect(actor).not.toBeNull();
    expect(actor?.role).toBe("GUEST");
  });

  it("rejects a requester whose role authority is unresolved", () => {
    expect(
      resolveRouteActor(AGENT_ID, OWNER_ID, {
        requesterEntityId: USER_ID,
      } satisfies AccessContext),
    ).toBeNull();
  });

  it("returns null when AccessContext lacks requesterEntityId", () => {
    const actor = resolveRouteActor(AGENT_ID, OWNER_ID, {
      role: "USER",
    } satisfies AccessContext);
    expect(actor).toBeNull();
  });

  it("uses isOwner flag to grant OWNER role even with USER role name", () => {
    const actor = resolveRouteActor(AGENT_ID, OWNER_ID, {
      requesterEntityId: OWNER_ID,
      role: "USER",
      isOwner: true,
    } satisfies AccessContext);
    expect(actor).not.toBeNull();
    expect(actor?.role).toBe("OWNER");
  });
});
