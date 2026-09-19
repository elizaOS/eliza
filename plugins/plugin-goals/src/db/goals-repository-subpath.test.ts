/**
 * Pins the vitest source anchor for `@elizaos/plugin-goals/db/goals-repository`,
 * the leaf PA's lifeops repository imports. Deterministic: the subpath import
 * must resolve to the same module instance as the source file, which fails
 * both when the alias is missing in a dist-less checkout (unresolvable) and
 * when it silently falls through to a stale `dist` copy (distinct instance).
 */

import * as viaSubpath from "@elizaos/plugin-goals/db/goals-repository";
import { describe, expect, it } from "vitest";
import * as viaSource from "./goals-repository.js";

describe("@elizaos/plugin-goals/db/goals-repository (vitest alias)", () => {
  it("resolves the package subpath to the source module", () => {
    expect(viaSubpath.GoalsRepository).toBe(viaSource.GoalsRepository);
    expect(viaSubpath.createGoalDefinition).toBe(
      viaSource.createGoalDefinition,
    );
  });
});
