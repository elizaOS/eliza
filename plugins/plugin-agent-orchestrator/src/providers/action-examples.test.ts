/**
 * Unit tests for action-examples provider: validates provider descriptor and role gates.
 */
import { describe, expect, it } from "vitest";
import { codingAgentExamplesProvider } from "./action-examples.ts";

describe("action-examples provider", () => {
  it("exports codingAgentExamplesProvider with expected metadata", () => {
    expect(codingAgentExamplesProvider.name).toBe("CODING_AGENT_EXAMPLES");
    expect(codingAgentExamplesProvider.position).toBe(-1);
    expect(codingAgentExamplesProvider.contexts).toContain("code");
    expect(codingAgentExamplesProvider.contexts).toContain("agent_internal");
    expect(codingAgentExamplesProvider.roleGate?.minRole).toBe("ADMIN");
  });
});
