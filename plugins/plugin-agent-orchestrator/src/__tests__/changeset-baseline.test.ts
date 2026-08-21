/**
 * Contract for shared-workdir changeset baseline subtraction (velvet-moth
 * live park: another app's pre-existing diff rendered as this session's
 * changeset). Deterministic — pure function over a captured change set.
 */

import { describe, expect, it } from "vitest";
import {
  subtractChangeSetBaseline,
  type WorkspaceChangeSet,
} from "../services/workspace-diff.js";

const changeSet: WorkspaceChangeSet = {
  changedFiles: [
    "data/apps/velvet-moth/index.html",
    "data/apps/color-pop/index.html",
    "data/apps/dad-jokes/script.js",
  ],
  diffStat: [
    " data/apps/velvet-moth/index.html | 120 ++++",
    " data/apps/color-pop/index.html   |  40 +-",
    " data/apps/dad-jokes/script.js    |  12 +-",
  ].join("\n"),
  diff: [
    "diff --git a/data/apps/velvet-moth/index.html b/data/apps/velvet-moth/index.html\n+<moth/>\n",
    "diff --git a/data/apps/color-pop/index.html b/data/apps/color-pop/index.html\n+<pop/>\n",
    "diff --git a/data/apps/dad-jokes/script.js b/data/apps/dad-jokes/script.js\n+lol()\n",
  ].join(""),
  truncated: false,
  capturedAt: 1755400000000,
};

describe("subtractChangeSetBaseline", () => {
  it("drops baseline files from the list, diffstat, and diff hunks", () => {
    const out = subtractChangeSetBaseline(changeSet, [
      "data/apps/color-pop/index.html",
      "data/apps/dad-jokes/script.js",
    ]);
    expect(out.changedFiles).toEqual(["data/apps/velvet-moth/index.html"]);
    expect(out.diff).toContain("velvet-moth");
    expect(out.diff).not.toContain("color-pop");
    expect(out.diff).not.toContain("dad-jokes");
    expect(out.diffStat).toContain("velvet-moth");
    expect(out.diffStat).not.toContain("color-pop");
  });

  it("no baseline overlap returns the identical change set", () => {
    const out = subtractChangeSetBaseline(changeSet, ["unrelated/file.ts"]);
    expect(out).toBe(changeSet);
  });

  it("empty baselines are a no-op", () => {
    expect(subtractChangeSetBaseline(changeSet, [])).toBe(changeSet);
  });
});
