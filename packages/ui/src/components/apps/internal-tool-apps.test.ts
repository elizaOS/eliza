import { describe, expect, it } from "vitest";
import { pathForTab, tabFromPath } from "../../navigation";
import {
  getInternalToolAppDescriptors,
  getInternalToolAppHasDetailsPage,
  getInternalToolApps,
  getInternalToolAppTargetTab,
  getInternalToolAppWindowPath,
} from "./internal-tool-apps";

describe("internal tool app descriptors", () => {
  it("bridges the Fine Tuning app route to the training tool tab", () => {
    const appName = "@elizaos/plugin-training";
    const descriptor = getInternalToolAppDescriptors().find(
      (item) => item.name === appName,
    );
    const catalogApp = getInternalToolApps().find(
      (item) => item.name === appName,
    );

    expect(getInternalToolAppWindowPath(appName)).toBe("/apps/fine-tuning");
    expect(getInternalToolAppTargetTab(appName)).toBe("fine-tuning");
    expect(getInternalToolAppHasDetailsPage(appName)).toBe(true);
    expect(pathForTab("fine-tuning")).toBe("/apps/fine-tuning");
    expect(tabFromPath("/apps/fine-tuning")).toBe("fine-tuning");
    expect(descriptor).toMatchObject({
      displayName: "Fine Tuning",
    });
    expect(catalogApp).toMatchObject({
      displayName: "Fine Tuning",
      description:
        "Collect training data, inspect trajectories, run Eliza harness evals, benchmark model tiers, and manage fine-tuned models.",
      capabilities: expect.arrayContaining([
        "training",
        "fine-tuning",
        "trajectories",
        "datasets",
        "models",
        "evals",
        "benchmarks",
        "analysis",
        "data-collection",
      ]),
    });
  });

  it("keeps internal window paths unique", () => {
    const paths = getInternalToolAppDescriptors()
      .map((descriptor) => descriptor.windowPath)
      .filter((path): path is string => path !== null);

    expect(new Set(paths).size).toBe(paths.length);
  });
});
