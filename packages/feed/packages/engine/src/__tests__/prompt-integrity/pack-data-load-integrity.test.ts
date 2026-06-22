import { describe, expect, it } from "vitest";
import type { Actor, Organization } from "../../types";
import { NPCPersonaGenerator } from "../../services/npc-persona-generator";
import { StaticDataRegistry } from "../../services/static-data-registry";

/**
 * Load-integrity guard for the recovered `./data/*` re-export modules.
 *
 * `StaticDataRegistry` auto-loads `@feed/pack-default` (actors / organizations /
 * correlations). Every feed/trading/question prompt is grounded on this data, so
 * a broken re-export shim would silently blank `worldActors`, `characterRoster`,
 * persona rivalries, etc. These tests fail loudly if the pack stops loading.
 */
describe("pack data load integrity", () => {
  it("loads the default actor roster from @feed/pack-default", () => {
    const actors = StaticDataRegistry.getAllActors();
    expect(actors.length).toBeGreaterThan(10);
    // Real parody names, not blank placeholders.
    expect(actors.every((a) => a.id.length > 0 && a.name.length > 0)).toBe(true);
  });

  it("loads the default organization roster", () => {
    const orgs = StaticDataRegistry.getAllOrganizations();
    expect(orgs.length).toBeGreaterThan(3);
    expect(orgs.every((o) => o.id.length > 0 && o.name.length > 0)).toBe(true);
  });

  it("loads correlations including competitor relationships", () => {
    const correlations = StaticDataRegistry.getCorrelations();
    expect(correlations.length).toBeGreaterThan(0);
    // The migrated OrgCorrelation shape uses `type` (not the old `relationship`).
    expect(correlations.some((c) => c.type === "competitor")).toBe(true);
  });

  it("produces non-empty org rivalries in NPC personas (regression: correlations field-name bug)", () => {
    const actors = StaticDataRegistry.getAllActors() as unknown as Actor[];
    const orgs = StaticDataRegistry.getAllOrganizations() as unknown as Organization[];
    const personas = new NPCPersonaGenerator().assignPersonas(actors, orgs);

    expect(personas.size).toBeGreaterThan(0);
    // Before the fix, getCompetitorMap read c.relationship/c.primary/c.related
    // (undefined on OrgCorrelation) so EVERY persona had opposesOrgs === [].
    const totalOpposedOrgs = [...personas.values()].reduce(
      (sum, p) => sum + p.opposesOrgs.length,
      0,
    );
    expect(totalOpposedOrgs).toBeGreaterThan(0);
  });
});
