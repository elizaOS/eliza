/**
 * Contract test for the visual-regression baseline inventory gate.
 *
 * Runs the real checker against the real committed snapshot directory, so a
 * route added to `tests/e2e/visual-routes.ts` without its baselines fails here
 * instead of in the homepage smoke job. No filesystem or git stubbing: the
 * tracked-inventory listing is exercised against this repository.
 */

import { describe, expect, test } from "bun:test";
import {
  findSnapshotInventoryProblems,
  listTrackedBaselineNames,
  SNAPSHOT_DIR,
} from "../scripts/check-snapshot-inventory";
import {
  expectedSnapshotNames,
  VISUAL_ROUTES,
  VISUAL_VIEWPORTS,
} from "./e2e/visual-routes";

describe("homepage snapshot inventory", () => {
  test("derives one Linux baseline per route and viewport", () => {
    const names = expectedSnapshotNames();
    expect(names).toHaveLength(VISUAL_ROUTES.length * VISUAL_VIEWPORTS.length);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("not-found-desktop-chromium-linux.png");
    expect(names).toContain("not-found-mobile-chromium-linux.png");
    for (const name of names) {
      expect(name.endsWith("-chromium-linux.png")).toBe(true);
    }
  });

  test("the committed baselines match the matrix exactly", () => {
    expect(findSnapshotInventoryProblems(listTrackedBaselineNames())).toEqual(
      [],
    );
  });

  test("tracked listing ignores locally regenerated platform baselines", () => {
    const tracked = listTrackedBaselineNames(SNAPSHOT_DIR);
    expect(tracked).toEqual(expectedSnapshotNames());
    expect(tracked.some((name) => !name.endsWith("-chromium-linux.png"))).toBe(
      false,
    );
  });

  test("reports a route whose baseline was never committed", () => {
    const [absent, ...rest] = expectedSnapshotNames();
    const problems = findSnapshotInventoryProblems(rest);
    expect(problems).toEqual([
      {
        kind: "missing",
        name: absent,
        file: `tests/e2e/visual.spec.ts-snapshots/${absent}`,
      },
    ]);
  });

  test("reports a baseline left behind by a renamed route", () => {
    const problems = findSnapshotInventoryProblems([
      ...expectedSnapshotNames(),
      "retired-route-desktop-chromium-linux.png",
    ]);
    expect(problems).toEqual([
      {
        kind: "unexpected",
        name: "retired-route-desktop-chromium-linux.png",
        file: "tests/e2e/visual.spec.ts-snapshots/retired-route-desktop-chromium-linux.png",
      },
    ]);
  });

  test("an empty inventory fails loudly rather than validating nothing", () => {
    expect(findSnapshotInventoryProblems([])).toHaveLength(
      expectedSnapshotNames().length,
    );
  });

  test("throws instead of reporting an empty inventory for a bad path", () => {
    expect(() =>
      listTrackedBaselineNames(`${SNAPSHOT_DIR}-does-not-exist`),
    ).toThrow();
  });
});
