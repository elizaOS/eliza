/** Exercises authenticated host-session disclosure through the real document actor policy. */
import {
  actorFromAccessContext,
  type IAgentRuntime,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { actorCanManageOwnerDocuments } from "./document-access.ts";
import { resolveHostSessionAccessContext } from "./host-session-access-context.ts";

const owner = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" as UUID;
const agentId = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" as UUID;
const runtime = {
  agentId,
  getSetting: (name: string) =>
    name === "ELIZA_ADMIN_ENTITY_ID" ? owner : null,
} as IAgentRuntime;

describe("host session document disclosure", () => {
  it("lets a verified owner manage owner documents using the canonical owner identity", () => {
    const context = resolveHostSessionAccessContext(
      { ok: true, role: "OWNER", identityId: "owner-login" },
      runtime,
    );
    if (!context) throw new Error("missing owner context");
    expect(context.requesterEntityId).toBe(owner);
    const actor = actorFromAccessContext(context, agentId);
    if (actor.role === "UNRESOLVED") throw new Error("unresolved actor");
    expect(actorCanManageOwnerDocuments({ ...actor, role: actor.role })).toBe(
      true,
    );
  });

  it("keeps a paired guest out of owner management even if its identity string matches the owner", () => {
    const context = resolveHostSessionAccessContext(
      { ok: true, role: "USER", identityId: owner },
      runtime,
    );
    if (!context) throw new Error("missing guest context");
    const actor = actorFromAccessContext(context, agentId);
    if (actor.role === "UNRESOLVED") throw new Error("unresolved actor");
    expect(actorCanManageOwnerDocuments({ ...actor, role: actor.role })).toBe(
      false,
    );
  });

  it("does not fabricate a principal for revoked or identity-less sessions", () => {
    expect(
      resolveHostSessionAccessContext({ ok: false, role: "NONE" }, runtime),
    ).toBeUndefined();
    expect(() =>
      resolveHostSessionAccessContext({ ok: true, role: "USER" }, runtime),
    ).toThrow(/stable session identity/);
  });
});
