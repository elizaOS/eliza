/** Verifies stable rowless identity and its canonical Eliza projection. */

import { describe, expect, test } from "bun:test";
import {
  isPersonalSharedAgentId,
  personalSharedAgent,
  personalSharedAgentId,
} from "./personal-shared-agent";

const account = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
};

describe("personalSharedAgent", () => {
  test("derives one stable namespaced id per account", () => {
    const id = personalSharedAgentId(account);
    expect(personalSharedAgentId({ ...account })).toBe(id);
    expect(id).toMatch(/^personal:[0-9a-f-]+$/);
    expect(isPersonalSharedAgentId(id)).toBe(true);
    expect(isPersonalSharedAgentId(id.slice("personal:".length))).toBe(false);
    expect(
      personalSharedAgentId({
        ...account,
        userId: "00000000-0000-4000-8000-000000000003",
      }),
    ).not.toBe(id);
  });

  test("projects Eliza without a sandbox record", () => {
    expect(personalSharedAgent(account)).toMatchObject({
      id: personalSharedAgentId(account),
      organization_id: account.organizationId,
      user_id: account.userId,
      character_id: null,
      agent_name: "Eliza",
      execution_tier: "shared",
      agent_config: { character: { name: "Eliza", source: "cloud" } },
    });
  });
});
