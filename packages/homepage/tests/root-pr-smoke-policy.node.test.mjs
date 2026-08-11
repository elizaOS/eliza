import { describe, expect, test } from "bun:test";
import {
  HOMEPAGE_ROOT_PR_IGNORES,
  resolveHomepageTestIgnore,
} from "../scripts/root-pr-smoke-policy.mjs";

describe("homepage root PR smoke policy", () => {
  test("routes only deployment-owned visual evidence out of root PR smoke", () => {
    expect(resolveHomepageTestIgnore({ TEST_LANE: "pr" })).toEqual([
      "visual.spec.ts",
      "contact-sheet-capture.spec.ts",
    ]);
    expect(HOMEPAGE_ROOT_PR_IGNORES).not.toContain("visual-readiness.spec.ts");
    expect(HOMEPAGE_ROOT_PR_IGNORES).not.toContain("live-routes.spec.ts");
  });

  test("keeps every homepage suite in its authoritative deployment lane", () => {
    expect(resolveHomepageTestIgnore({})).toBeUndefined();
    expect(
      resolveHomepageTestIgnore({ TEST_LANE: "homepage-deploy" }),
    ).toBeUndefined();
  });
});
