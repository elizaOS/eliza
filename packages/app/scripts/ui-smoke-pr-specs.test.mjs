/**
 * Pins the keyless PR spec selection used by the real Playwright launcher.
 */

import { describe, expect, it } from "vitest";
import {
  runnablePrSpecPaths,
  withPrUiSmokeSpecs,
} from "./ui-smoke-pr-specs.mjs";

const uiSmokeConfig = ["--config", "playwright.ui-smoke.config.ts"];
const broadAudit = "test/ui-smoke/all-views-interaction.spec.ts";

describe("ui-smoke PR selection", () => {
  it("adds exactly the checked-in keyless inventory to an unscoped PR run", () => {
    const runnable = runnablePrSpecPaths();
    expect(runnable.length).toBeGreaterThan(0);
    expect(runnable).not.toContain(broadAudit);
    expect(withPrUiSmokeSpecs(uiSmokeConfig, "pr")).toEqual([
      ...uiSmokeConfig,
      ...runnable,
    ]);
  });

  it("preserves an explicit deny-listed spec for its on-demand lane", () => {
    expect(withPrUiSmokeSpecs([...uiSmokeConfig, broadAudit], "pr")).toEqual([
      ...uiSmokeConfig,
      broadAudit,
    ]);
  });

  it("does not scope post-merge or non-ui-smoke Playwright runs", () => {
    expect(withPrUiSmokeSpecs(uiSmokeConfig, "post-merge")).toEqual(
      uiSmokeConfig,
    );
    expect(
      withPrUiSmokeSpecs(["--config", "playwright.dev-smoke.config.ts"], "pr"),
    ).toEqual(["--config", "playwright.dev-smoke.config.ts"]);
  });
});
