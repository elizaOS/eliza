// Exercises agent github return behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import { resolveAgentReturnUrl } from "../agent-github-return";

// The GitHub OAuth return URL is attacker-influenceable and later used in a
// redirect, so it must be allow-listed to agent:// deep links of lifeops/settings
// only — anything else (wrong scheme, other path, junk) is an open-redirect and
// must resolve to null.
describe("resolveAgentReturnUrl (open-redirect guard)", () => {
  test("accepts the allow-listed agent:// deep links (trimmed)", () => {
    expect(resolveAgentReturnUrl("agent://lifeops")).toBe("agent://lifeops");
    expect(resolveAgentReturnUrl("agent://settings")).toBe("agent://settings");
    expect(resolveAgentReturnUrl("  agent://lifeops  ")).toBe("agent://lifeops");
  });

  test("rejects empty / unparseable inputs", () => {
    expect(resolveAgentReturnUrl(null)).toBeNull();
    expect(resolveAgentReturnUrl(undefined)).toBeNull();
    expect(resolveAgentReturnUrl("")).toBeNull();
    expect(resolveAgentReturnUrl("not a url")).toBeNull();
  });

  test("rejects non-agent schemes (the open-redirect vectors)", () => {
    expect(resolveAgentReturnUrl("http://evil.com")).toBeNull();
    expect(resolveAgentReturnUrl("https://evil.com/agent")).toBeNull();
    expect(resolveAgentReturnUrl("javascript:alert(1)")).toBeNull();
  });

  test("rejects non-allow-listed agent paths", () => {
    expect(resolveAgentReturnUrl("agent://admin")).toBeNull();
    expect(resolveAgentReturnUrl("agent://wallet")).toBeNull();
    expect(resolveAgentReturnUrl("agent://lifeops/extra")).toBeNull();
  });
});
