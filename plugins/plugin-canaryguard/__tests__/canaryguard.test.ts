import { describe, it, expect } from "vitest";
import { canaryGuardPlugin } from "../src/index";
import { sanitizeAction } from "../src/actions/sanitize";
import { canaryGuardProvider } from "../src/providers/status";

describe("CanaryGuard Plugin", () => {
  it("exports a valid ElizaOS plugin configuration", () => {
    expect(canaryGuardPlugin.name).toBe("canaryguard");
    expect(canaryGuardPlugin.actions).toHaveLength(1);
    expect(canaryGuardPlugin.actions[0].name).toBe("CANARY_SANITIZE");
    expect(canaryGuardPlugin.evaluators).toHaveLength(1);
    expect(canaryGuardPlugin.providers).toHaveLength(1);
  });

  it("validates messages with text content", async () => {
    const valid = await sanitizeAction.validate(
      {} as any,
      { content: { text: "Hello" } } as any
    );
    expect(valid).toBe(true);

    const invalid = await sanitizeAction.validate(
      {} as any,
      { content: {} } as any
    );
    expect(invalid).toBe(false);
  });

  it("provides active firewall status context", async () => {
    const status = await canaryGuardProvider.get(
      {} as any,
      {} as any,
      {} as any
    );
    expect(status).toContain("CanaryGuard 402");
    expect(status).toContain("ACTIVE");
  });
});
