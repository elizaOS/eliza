/**
 * Cross-plugin guard: every `shouldFire.gate` kind referenced by any health
 * default pack MUST resolve in plugin-scheduling's built-in gate registry.
 *
 * Why this lives here (#8795): `sleep-recap` referenced
 * `personal_baseline_sufficient`, which `registerBuiltInGates` never
 * registered. The runner treats an unregistered gate kind as a hard `deny`
 * ("unknown gate kind: <kind>") → `status="skipped"` with no dispatch, so the
 * pack could never fire. A zero-registrar gate is invisible to single-plugin
 * tests; only a cross-plugin coverage check catches it. This guard fails the
 * moment a pack adds a gate kind nobody registers.
 */

import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "@elizaos/plugin-scheduling";
import { describe, expect, it } from "vitest";

import { HEALTH_DEFAULT_PACKS } from "./index.js";

function collectReferencedGateKinds(): string[] {
  const kinds = new Set<string>();
  for (const pack of HEALTH_DEFAULT_PACKS) {
    for (const record of pack.records) {
      for (const gate of record.shouldFire?.gates ?? []) {
        kinds.add(gate.kind);
      }
    }
  }
  return [...kinds];
}

describe("health default packs: gate coverage (#8795)", () => {
  it("references at least one gate kind (guard is meaningful)", () => {
    expect(collectReferencedGateKinds().length).toBeGreaterThan(0);
  });

  it("every referenced gate kind resolves in the built-in registry", () => {
    const reg = createTaskGateRegistry();
    registerBuiltInGates(reg);

    const unresolved = collectReferencedGateKinds().filter(
      (kind) => reg.get(kind) === null,
    );

    // If this fails, a default pack references a gate kind that no plugin
    // registers — that pack can NEVER fire (runner denies "unknown gate kind").
    // Either register the gate in plugin-scheduling's registerBuiltInGates or
    // remove the gate from the pack.
    expect(unresolved).toEqual([]);
  });

  it("specifically resolves personal_baseline_sufficient (sleep-recap)", () => {
    const reg = createTaskGateRegistry();
    registerBuiltInGates(reg);
    expect(collectReferencedGateKinds()).toContain(
      "personal_baseline_sufficient",
    );
    expect(reg.get("personal_baseline_sufficient")).not.toBeNull();
  });
});
