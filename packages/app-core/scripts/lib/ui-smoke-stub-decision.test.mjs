/** Exercises ui smoke stub decision behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import { shouldForceStubStack } from "./ui-smoke-stub-decision.mjs";

describe("shouldForceStubStack", () => {
  it("forces the stub when ELIZA_UI_SMOKE_FORCE_STUB=1, unconditionally", () => {
    expect(shouldForceStubStack({ ELIZA_UI_SMOKE_FORCE_STUB: "1" })).toBe(true);
    // Force wins even if a live opt-in is also present.
    expect(
      shouldForceStubStack({
        ELIZA_UI_SMOKE_FORCE_STUB: "1",
        ELIZA_UI_SMOKE_LIVE_STACK: "1",
        CI: "true",
      }),
    ).toBe(true);
  });

  it("forces the stub under CI by default (historical behavior)", () => {
    expect(shouldForceStubStack({ CI: "true" })).toBe(true);
  });

  it("lets an explicit live opt-in override the CI stub force", () => {
    // This is the keystone: a gated live lane sets CI=true (GitHub Actions
    // always does) AND ELIZA_UI_SMOKE_LIVE_STACK=1 to reach the real backend.
    expect(
      shouldForceStubStack({ CI: "true", ELIZA_UI_SMOKE_LIVE_STACK: "1" }),
    ).toBe(false);
  });

  it("does not force the stub for a local live run (no CI, no force)", () => {
    expect(shouldForceStubStack({})).toBe(false);
    expect(shouldForceStubStack({ ELIZA_UI_SMOKE_LIVE_STACK: "1" })).toBe(
      false,
    );
  });

  it("ignores non-canonical truthy values", () => {
    // Only the literal "1" / "true" enable the respective behaviors.
    expect(shouldForceStubStack({ ELIZA_UI_SMOKE_FORCE_STUB: "true" })).toBe(
      false,
    );
    expect(shouldForceStubStack({ CI: "1" })).toBe(false);
    expect(
      shouldForceStubStack({ CI: "true", ELIZA_UI_SMOKE_LIVE_STACK: "yes" }),
    ).toBe(true);
  });
});
