/**
 * The contact book and its follow-ups are ADMIN data, like the `contacts`
 * context and the CONTACT action. A USER in a shared room must not get them
 * through the USER-allowed `memory` or `general` contexts. Real planner
 * provider selection over the registered providers and default contexts.
 */
import {
  type IAgentRuntime,
  type Memory,
  type Role,
  satisfiesRoleGate,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../../runtime/default-contexts.ts";
import { selectV5PlannerStateProviderNames } from "../../../services/message/provider-state.ts";
import { basicProviders } from "../../basic-capabilities/index.ts";
import { advancedProviders } from "../index.ts";

function selectedProviders(role: Role): string[] {
  const allowed = DEFAULT_CONTEXT_DEFINITIONS.filter((definition) =>
    satisfiesRoleGate([role], definition.roleGate),
  ).map((definition) => definition.id);
  return selectV5PlannerStateProviderNames({
    runtime: {
      providers: [...basicProviders, ...advancedProviders],
      agentId: "agent",
      getSetting: () => undefined,
      character: { name: "Eliza" },
    } as unknown as IAgentRuntime,
    message: {
      content: { text: "who is in your contacts?", source: "discord" },
      entityId: "sender",
      roomId: "group-room",
    } as unknown as Memory,
    selectedContexts: ["general", "memory"].filter((id) =>
      allowed.includes(id),
    ) as never,
    userRoles: [role],
  });
}

describe("contact book providers", () => {
  it("are not composed for a USER", () => {
    const names = selectedProviders("USER" as Role);
    expect(names).not.toContain("CONTACTS");
    expect(names).not.toContain("FOLLOW_UPS");
  });

  it("are composed for an ADMIN", () => {
    const names = selectedProviders("ADMIN" as Role);
    expect(names).toContain("CONTACTS");
    expect(names).toContain("FOLLOW_UPS");
  });
});
