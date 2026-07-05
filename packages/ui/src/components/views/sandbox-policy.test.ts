// Sandbox-attribute policy (#14180): the MDN foot-gun guard that a framed view
// never gets `allow-scripts` + `allow-same-origin` together (which would make
// the sandbox decorative). Pure logic, no DOM.

import { describe, expect, it } from "vitest";
import {
  assertRealSandbox,
  isRealSandbox,
  resolveSandboxTokens,
  SANDBOXED_VIEW_TOKENS,
  SandboxPolicyError,
} from "./sandbox-policy";

describe("sandbox-policy", () => {
  it("the default token set runs scripts but is NOT same-origin", () => {
    expect(SANDBOXED_VIEW_TOKENS).toContain("allow-scripts");
    expect(SANDBOXED_VIEW_TOKENS).not.toContain("allow-same-origin");
    expect(isRealSandbox(SANDBOXED_VIEW_TOKENS)).toBe(true);
  });

  it("flags the allow-scripts + allow-same-origin pairing as not a real sandbox", () => {
    expect(isRealSandbox(["allow-scripts", "allow-same-origin"])).toBe(false);
    expect(() =>
      assertRealSandbox(["allow-scripts", "allow-same-origin"]),
    ).toThrow(SandboxPolicyError);
  });

  it("allows same-origin alone or scripts alone (only the pairing is unsafe)", () => {
    expect(isRealSandbox(["allow-same-origin"])).toBe(true);
    expect(isRealSandbox(["allow-scripts"])).toBe(true);
    expect(isRealSandbox(["allow-scripts", "allow-forms"])).toBe(true);
  });

  it("resolveSandboxTokens returns a deterministic, real-sandbox attribute string", () => {
    const tokens = resolveSandboxTokens();
    expect(tokens).toBe("allow-scripts");
    // Sorted + deduped regardless of extra order.
    expect(resolveSandboxTokens(["allow-forms", "allow-scripts"])).toBe(
      "allow-forms allow-scripts",
    );
  });

  it("resolveSandboxTokens REFUSES a request that would defeat the sandbox", () => {
    expect(() => resolveSandboxTokens(["allow-same-origin"])).toThrow(
      SandboxPolicyError,
    );
  });
});
