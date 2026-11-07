/** Network capabilities reuse the existing Personal identity; legacy ids are inventory only. */

import { describe, expect, test } from "bun:test";
import { capabilityHandoffTargetAgentId } from "@elizaos/core/protocol";
import { v5 as uuidv5 } from "uuid";
import { personalSharedAgent } from "./personal-shared-agent";
import {
  isCanonicalPersonalSharedAgent,
  isPersonalSharedAgentId,
  legacyNetworkPersonalSharedAgentId,
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
    // Product selection never changes the canonical account identity.
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

  test("Network reuses the original Personal id; its old id is inventory only", () => {
    const networkId = personalSharedAgentId({ ...account, project: "network" });
    expect(networkId).toBe(legacyElizaId);
    const oldId = legacyNetworkPersonalSharedAgentId(account);
    expect(oldId).toBe(
      `personal:${uuidv5(`network:${account.organizationId}:${account.userId}`, NAMESPACE)}`,
    );
    expect(oldId).not.toBe(networkId);
    expect(
      isCanonicalPersonalSharedAgent({
        ...personalSharedAgent({ ...account, project: "network" }),
        id: oldId,
      }),
    ).toBe(false);
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

  test("canonical USER authority binds the account; product markers do not change the owner", () => {
    const network = personalSharedAgent({ ...account, project: "network" });
    const eliza = personalSharedAgent(account);
    expect(network.project).toBe("network");
    expect(isCanonicalPersonalSharedAgent(network)).toBe(true);
    expect(isCanonicalPersonalSharedAgent(eliza)).toBe(true);
    // USER identity alone grants no Network actions. sharedNetworkExecution
    // separately requires the server-owned project and Personal DM authority.
    expect(isCanonicalPersonalSharedAgent({ ...network, project: undefined })).toBe(true);
    expect(isCanonicalPersonalSharedAgent({ ...eliza, project: "network" })).toBe(true);
    expect(isCanonicalPersonalSharedAgent({ ...network, user_id: "foreign-user" })).toBe(false);
    expect(isCanonicalPersonalSharedAgent({ ...network, organization_id: "foreign-org" })).toBe(
      false,
    );
    expect(isCanonicalPersonalSharedAgent({ ...network, execution_tier: "dedicated-always" })).toBe(
      false,
    );
  });

  test("Network and original Personal turns address the same Durable Object history", () => {
    // conversation-coordinator names the DO `${agentId}:${room}` and personal
    // turns use the agent id as the room.
    const doName = (id: string) => `${id}:${id}`;
    const eliza = personalSharedAgent(account);
    const network = personalSharedAgent({ ...account, project: "network" });
    expect(doName(network.id)).toBe(doName(eliza.id));
  });
});
