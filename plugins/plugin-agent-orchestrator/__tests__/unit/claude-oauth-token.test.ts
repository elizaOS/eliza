import { describe, expect, it } from "vitest";
import { isClaudeOAuthSubscriptionToken } from "../../src/services/acp-service.js";

// Guards the discriminator behind buildEnv's claude auth-env policy: a claude
// sub-agent (claude-agent-acp wrapping Claude Code) must have an OAuth
// subscription token stripped from ANTHROPIC_API_KEY (it can't auth as an API
// key), but a real API key (sk-ant-api…) must be preserved — stripping both
// would break deployments that auth a sub-agent with a genuine API key.
describe("isClaudeOAuthSubscriptionToken", () => {
  it("returns true for an OAuth subscription token (sk-ant-oat…)", () => {
    expect(isClaudeOAuthSubscriptionToken("sk-ant-oat01-abc123")).toBe(true);
  });

  it("returns false for a real API key (sk-ant-api…) so it is preserved", () => {
    expect(isClaudeOAuthSubscriptionToken("sk-ant-api03-xyz789")).toBe(false);
  });

  it("returns false for undefined / empty", () => {
    expect(isClaudeOAuthSubscriptionToken(undefined)).toBe(false);
    expect(isClaudeOAuthSubscriptionToken("")).toBe(false);
  });

  it("returns false for any other non-oat string", () => {
    expect(
      isClaudeOAuthSubscriptionToken("oauth-sk-ant-oat-not-a-prefix"),
    ).toBe(false);
  });
});
