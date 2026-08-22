/**
 * Proves the app's interaction authority comes from production view and control
 * registrations rather than test-owned view rosters or mutation-site counts.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  __test,
  discoverViewOperationLedger,
} from "../../scripts/lib/view-operation-ledger.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
let ledger: ReturnType<typeof discoverViewOperationLedger>;

describe("production view operation coverage", () => {
  beforeAll(() => {
    ledger = discoverViewOperationLedger({ repoRoot: REPO_ROOT });
  }, 30_000);

  it("reconciles the complete runtime view and registered-surface inventory", () => {
    expect(ledger.viewInventoryCount).toBe(39);
    expect(ledger.registeredSurfaceCount).toBe(11);
    expect(ledger.registrationOverlapCount).toBe(7);
    expect(ledger.surfaceCount).toBe(43);
    expect(
      ledger.viewInventoryCount +
        ledger.registeredSurfaceCount -
        ledger.registrationOverlapCount,
    ).toBe(ledger.surfaceCount);
    expect(new Set(ledger.surfaces.map((surface) => surface.id)).size).toBe(
      ledger.surfaceCount,
    );
    expect(
      new Set(ledger.operations.map((operation) => operation.surfaceId)),
    ).toEqual(new Set(ledger.surfaces.map((surface) => surface.id)));
  });

  it("gives every operation one complete gate, delivery, and evidence contract", () => {
    for (const operation of ledger.operations) {
      expect(operation.operationId).not.toBe("");
      expect(operation.owner).not.toBe("");
      expect(operation.useCase).not.toBe("");
      expect(operation.input).toBeDefined();
      expect(operation.output).toBeDefined();
      expect(operation.errors).toBeDefined();
      expect(operation.gate).toBeDefined();
      expect(operation.delivery).toBeDefined();
      expect(operation.evidence.implementation).toMatch(/:\d+$/);
    }
  });

  it("keeps sensitive controls outside ordinary chat and voice delivery", () => {
    const leaks = ledger.operations.filter(
      (operation) =>
        operation.sensitive &&
        (operation.channels.chat || operation.channels.voice),
    );
    expect(leaks).toEqual([]);
  });

  it("projects every ordinary agent control through widget, chat, and voice", () => {
    const gaps = ledger.operations.filter(
      (operation) =>
        operation.classification === "agent-operation" &&
        (!operation.channels.widget ||
          !operation.channels.chat ||
          !operation.channels.voice),
    );
    expect(gaps).toEqual([]);
  });

  it("bounds view-only exceptions and reports no semantic mutation escape", () => {
    expect(ledger.semanticMutationCounts.viewOnlyViolations).toBe(0);
    for (const operation of ledger.operations.filter(
      (candidate) => candidate.classification === "view-only",
    )) {
      expect(operation.justificationCode).toBeDefined();
      expect(__test.VIEW_ONLY_JUSTIFICATIONS[operation.justificationCode]).toBe(
        operation.viewOnlyReason,
      );
    }
  });
});
