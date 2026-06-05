import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ViewCapability } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import taskCoordinatorPlugin from "../../src/index";

/**
 * Regression guard for orchestrator capability manifest↔dispatch parity.
 *
 * The orchestrator views declare their capabilities in `src/index.ts`
 * (`ORCHESTRATOR_CAPABILITIES`); `runOrchestratorCapability()` in
 * `src/orchestrator-capabilities.ts` dispatches on the same ids. If the two drift
 * — a capability declared but not handled, or handled but not declared — a
 * voice/NL planner either surfaces an action that no-ops or can't discover one
 * that works. This locks the two in step so the drift can't reopen silently
 * (it previously had: `orchestrator-update-task`/`-validate-task` were
 * dispatched but undeclared).
 *
 * The dispatch side is read from source text rather than imported so the test
 * stays free of the React/runtime dependencies that `OrchestratorWorkbench.tsx`
 * pulls in.
 */
function manifestCapabilityIds(): Set<string> {
  const ids = new Set<string>();
  for (const view of taskCoordinatorPlugin.views ?? []) {
    if (view.id !== "orchestrator") continue;
    for (const cap of (view.capabilities ?? []) as ViewCapability[]) {
      ids.add(cap.id);
    }
  }
  return ids;
}

function dispatchedCapabilityIds(): Set<string> {
  const source = readFileSync(
    fileURLToPath(
      new URL("../../src/orchestrator-capabilities.ts", import.meta.url),
    ),
    "utf8",
  );
  const ids = new Set<string>();
  for (const match of source.matchAll(/case\s+"(orchestrator-[a-z-]+)"/g)) {
    ids.add(match[1]);
  }
  return ids;
}

describe("orchestrator capability manifest↔dispatch parity", () => {
  it("declares exactly the capabilities runOrchestratorCapability dispatches", () => {
    const manifest = manifestCapabilityIds();
    const dispatched = dispatchedCapabilityIds();

    expect(manifest.size).toBeGreaterThan(0);
    expect(dispatched.size).toBeGreaterThan(0);

    const declaredNotDispatched = [...manifest]
      .filter((id) => !dispatched.has(id))
      .sort();
    const dispatchedNotDeclared = [...dispatched]
      .filter((id) => !manifest.has(id))
      .sort();

    expect(declaredNotDispatched).toEqual([]);
    expect(dispatchedNotDeclared).toEqual([]);
  });
});
