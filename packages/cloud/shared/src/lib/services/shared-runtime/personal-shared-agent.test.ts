/** Verifies the rowless personal Eliza identity and default runtime projection. */

import { describe, expect, test } from "bun:test";
import {
  isPersonalSharedAgentId,
  personalDedicatedAgentApiBase,
  personalSharedAgent,
  personalSharedAgentId,
} from "./personal-shared-agent";

const account = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
};

describe("personalSharedAgent", () => {
  test("derives one stable identity per account without a sandbox row", () => {
    const first = personalSharedAgentId(account);
    const second = personalSharedAgentId({ ...account });
    const otherUser = personalSharedAgentId({
      ...account,
      userId: "00000000-0000-4000-8000-000000000003",
    });

    expect(first).toBe(second);
    expect(first).toMatch(
      /^personal:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(isPersonalSharedAgentId(first)).toBe(true);
    expect(isPersonalSharedAgentId(first.slice("personal:".length))).toBe(false);
    expect(otherUser).not.toBe(first);
  });

  test("projects the canonical Eliza character onto the shared runtime", () => {
    const agent = personalSharedAgent(account);

    expect(agent).toMatchObject({
      id: personalSharedAgentId(account),
      organization_id: account.organizationId,
      user_id: account.userId,
      character_id: null,
      agent_name: "Eliza",
      execution_tier: "shared",
    });
    expect(agent.agent_config?.character).toMatchObject({
      name: "Eliza",
      source: "cloud",
    });
  });

  test("uses canonical production routing and only the explicit local loopback fallback", () => {
    const target = {
      id: "00000000-0000-4000-8000-000000000004",
      headscale_ip: null,
      bridge_url: "http://127.0.0.1:8787/api/compat/agents/local",
    };

    expect(personalDedicatedAgentApiBase(target, "cloud.eliza.app")).toBe(
      `https://${target.id}.cloud.eliza.app`,
    );
    expect(personalDedicatedAgentApiBase(target, "https://")).toBe(target.bridge_url);
    expect(
      personalDedicatedAgentApiBase(
        { ...target, bridge_url: "https://attacker.example/agent" },
        "https://",
      ),
    ).toBeNull();
    expect(
      personalDedicatedAgentApiBase(
        { ...target, bridge_url: "http://user:secret@127.0.0.1:8787" },
        "https://",
      ),
    ).toBeNull();
  });
});
