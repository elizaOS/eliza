/**
 * Deterministic unit coverage for the latest dist-tag reconciliation policy.
 * Exercises the pure planner only; no npm registry access is involved.
 */

import { describe, expect, test } from "bun:test";
import { planLatestSync } from "../sync-latest-dist-tags.mjs";

describe("planLatestSync", () => {
  test("retags prerelease-only packages whose latest drifted off the beta channel", () => {
    expect(
      planLatestSync({
        packageName: "@x/a",
        versions: ["2.0.3-beta.7", "2.0.11-beta.7"],
        distTags: { latest: "2.0.11-beta.7", beta: "2.0.3-beta.7" },
      }),
    ).toEqual({
      packageName: "@x/a",
      from: "2.0.11-beta.7",
      to: "2.0.3-beta.7",
    });
    expect(
      planLatestSync({
        packageName: "@x/a",
        versions: ["2.0.3-beta.7"],
        distTags: { beta: "2.0.3-beta.7" },
      }),
    ).toEqual({
      packageName: "@x/a",
      from: "(unset)",
      to: "2.0.3-beta.7",
    });
  });

  test("never touches packages with a stable release", () => {
    expect(
      planLatestSync({
        packageName: "@x/a",
        versions: ["1.7.2", "2.0.3-beta.7"],
        distTags: { latest: "1.7.2", beta: "2.0.3-beta.7" },
      }),
    ).toBeNull();
  });

  test("leaves aligned, unpublished, and unbetad packages alone", () => {
    expect(
      planLatestSync({
        packageName: "@x/a",
        versions: ["2.0.3-beta.7"],
        distTags: { latest: "2.0.3-beta.7", beta: "2.0.3-beta.7" },
      }),
    ).toBeNull();
    expect(
      planLatestSync({ packageName: "@x/a", versions: [], distTags: {} }),
    ).toBeNull();
    expect(
      planLatestSync({
        packageName: "@x/a",
        versions: ["2.0.3-beta.7"],
        distTags: { latest: "2.0.3-beta.7" },
      }),
    ).toBeNull();
  });
});
