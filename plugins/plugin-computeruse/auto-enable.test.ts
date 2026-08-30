/** Verifies import-light Computer Use discovery from documented opt-in signals. */
import { describe, expect, it } from "vitest";
import { shouldEnable } from "./auto-enable";

function context(
  config: Record<string, unknown> = {},
  env: Record<string, string | undefined> = {},
) {
  return { config, env, isNativePlatform: false };
}

describe("computer-use auto-enable", () => {
  it("enables from the Settings capability toggle", () => {
    expect(
      shouldEnable(context({ ui: { capabilities: { computerUse: true } } })),
    ).toBe(true);
  });

  it("enables from the boolean feature flag", () => {
    expect(shouldEnable(context({ features: { computeruse: true } }))).toBe(
      true,
    );
  });

  it("enables from an enabled feature object", () => {
    expect(
      shouldEnable(context({ features: { computeruse: { enabled: true } } })),
    ).toBe(true);
  });

  it("enables from the documented environment opt-in", () => {
    expect(shouldEnable(context({}, { COMPUTER_USE_ENABLED: "1" }))).toBe(true);
  });

  it("stays disabled for missing and explicit false signals", () => {
    expect(shouldEnable(context())).toBe(false);
    expect(
      shouldEnable(
        context(
          {
            ui: { capabilities: { computerUse: false } },
            features: { computeruse: { enabled: false } },
          },
          { COMPUTER_USE_ENABLED: "0" },
        ),
      ),
    ).toBe(false);
  });
});
