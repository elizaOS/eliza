/**
 * Tests for the arklib-clone plugin — verifies that the clone action is properly
 * registered and that buildCloneResult produces the expected shape.
 */

import { describe, expect, it } from "vitest";
import plugin, {
  buildCloneResult,
  ARKLIB_REPO,
  PROXIMITY_PRIZE_BRANCH,
} from "../src/plugin.js";

describe("runtime template", () => {
  it("does not register template hello actions", () => {
    const actionNames = (plugin.actions ?? []).map((action) => action.name);

    expect(actionNames).not.toContain("arklib-clone_HELLO");
    expect(actionNames).not.toContain("__PLUGIN_NAME___HELLO");
  });
});

describe("CLONE_ARKLIB action", () => {
  it("is registered in the plugin", () => {
    const actionNames = (plugin.actions ?? []).map((a) => a.name);
    expect(actionNames).toContain("CLONE_ARKLIB");
  });

  it("buildCloneResult returns the expected shape for a fresh clone", () => {
    const sha = "623aaeb4b8fa";
    const result = buildCloneResult(
      ARKLIB_REPO,
      PROXIMITY_PRIZE_BRANCH,
      sha,
      "cloned",
    );

    expect(result.repoUrl).toBe(ARKLIB_REPO);
    expect(result.branch).toBe(PROXIMITY_PRIZE_BRANCH);
    expect(result.commitSha).toBe(sha);
    expect(result.status).toBe("cloned");
  });

  it("buildCloneResult handles already_present status", () => {
    const result = buildCloneResult(
      ARKLIB_REPO,
      PROXIMITY_PRIZE_BRANCH,
      "abc123",
      "already_present",
    );
    expect(result.status).toBe("already_present");
  });
});
