/** Project-scoped Personal Shared identity: Network gets its own id; Eliza ids are unchanged. */

import { describe, expect, test } from "bun:test";
import { capabilityHandoffTargetAgentId } from "@elizaos/core/capability-catalog";
import { v5 as uuidv5 } from "uuid";
import { personalSharedAgent } from "./personal-shared-agent";
import {
  isCanonicalPersonalSharedAgent,
  isPersonalSharedAgentId,
  personalSharedAgentId,
  personalSharedProjectScope,
} from "./personal-shared-identity";

const NAMESPACE = "af8f7624-42f8-4da8-bdf1-593b1a0d7f20";
const account = {
  organizationId: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
};
const legacyElizaId = `personal:${uuidv5(`${account.organizationId}:${account.userId}`, NAMESPACE)}`;

describe("personal Shared identity", () => {
  test("Eliza ids are byte-identical to the pre-project derivation", () => {
    expect(personalSharedAgentId(account)).toBe(legacyElizaId);
    expect(personalSharedAgentId({ ...account, project: "eliza-app" })).toBe(legacyElizaId);
    // Only explicitly project-scoped products change the key; an unknown
    // project name (or a casing/whitespace variant of eliza-app) does not.
    expect(personalSharedAgentId({ ...account, project: "soulmates" })).toBe(legacyElizaId);
    expect(personalSharedAgentId({ ...account, project: " Eliza-App " })).toBe(legacyElizaId);
    expect(personalSharedAgent(account)).toEqual({
      id: legacyElizaId,
      organization_id: account.organizationId,
      user_id: account.userId,
      character_id: null,
      agent_name: expect.any(String),
      agent_config: expect.any(Object),
      execution_tier: "shared",
    });
    expect("project" in personalSharedAgent({ ...account, project: "eliza-app" })).toBe(false);
  });

  test("Network derives a separate personal: id from (org, user, project)", () => {
    const networkId = personalSharedAgentId({ ...account, project: "network" });
    expect(networkId).not.toBe(legacyElizaId);
    expect(networkId).toBe(
      `personal:${uuidv5(`network:${account.organizationId}:${account.userId}`, NAMESPACE)}`,
    );
    expect(personalSharedAgentId({ ...account, project: "NETWORK" })).toBe(networkId);
    expect(personalSharedProjectScope("network")).toBe("network");
    expect(personalSharedProjectScope("eliza-app")).toBeUndefined();
    // Different accounts never collide within the Network scope.
    expect(
      personalSharedAgentId({
        ...account,
        userId: "00000000-0000-4000-8000-000000000001",
        project: "network",
      }),
    ).not.toBe(networkId);
  });

  test("the Network id keeps every personal: prefix contract", () => {
    const networkId = personalSharedAgentId({ ...account, project: "network" });
    // resolve-shared-agent, the DO (funding + history store), keepwarm, reminder
    // cron, voice and wallet routes all gate on this predicate or the prefix.
    expect(isPersonalSharedAgentId(networkId)).toBe(true);
    expect(networkId.startsWith("personal:")).toBe(true);
    // packages/core capability handoff accepts the same shape.
    expect(capabilityHandoffTargetAgentId(`/cloud/agents/${encodeURIComponent(networkId)}`)).toBe(
      networkId,
    );
  });

  test("canonical USER authority binds the project into the check", () => {
    const network = personalSharedAgent({ ...account, project: "network" });
    const eliza = personalSharedAgent(account);
    expect(network.project).toBe("network");
    expect(isCanonicalPersonalSharedAgent(network)).toBe(true);
    expect(isCanonicalPersonalSharedAgent(eliza)).toBe(true);
    // A Network id presented without its project, or an Eliza id claiming the
    // Network project, is not canonical and gets no USER authority.
    expect(isCanonicalPersonalSharedAgent({ ...network, project: undefined })).toBe(false);
    expect(isCanonicalPersonalSharedAgent({ ...eliza, project: "network" })).toBe(false);
  });

  test("Durable Object names differ, so Network and Eliza never share history", () => {
    // conversation-coordinator names the DO `${agentId}:${room}` and personal
    // turns use the agent id as the room.
    const doName = (id: string) => `${id}:${id}`;
    const eliza = personalSharedAgent(account);
    const network = personalSharedAgent({ ...account, project: "network" });
    expect(doName(network.id)).not.toBe(doName(eliza.id));
  });
});
