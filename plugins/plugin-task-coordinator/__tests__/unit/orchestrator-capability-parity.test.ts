/**
 * Regression guard for orchestrator capability manifest↔dispatch parity.
 *
 * The orchestrator views declare their capabilities in `src/index.ts`
 * (`ORCHESTRATOR_CAPABILITIES`); `src/orchestrator-capabilities.ts` exports the
 * gate set (`ORCHESTRATOR_CAPABILITY_IDS`, the registry `interact` checks
 * before dispatch) and the dispatcher (`runOrchestratorCapability`). If those
 * drift — a capability declared but not handled, or handled but not declared —
 * a voice/NL planner either surfaces an action that no-ops or can't discover
 * one that works (it previously had: `orchestrator-update-task` /
 * `-validate-task` were dispatched but undeclared).
 *
 * This compares the REAL imported objects structurally (no source-text regex),
 * and drives the real dispatcher for every declared id to prove none falls
 * through to the unknown-capability branch. Only the `@elizaos/ui` HTTP client
 * — the module's outbound boundary — is faked.
 */
import type { ViewCapability } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui", () => ({
  // Every client method resolves benignly; list returns [] so the open-task
  // fallback path terminates without a second-stage fetch.
  client: new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "listCodingAgentTaskThreads") {
          return async () => [];
        }
        return async () => ({ ok: true });
      },
    },
  ),
}));

import taskCoordinatorPlugin from "../../src/index";
import {
  ORCHESTRATOR_CAPABILITY_IDS,
  runOrchestratorCapability,
} from "../../src/orchestrator-capabilities";

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

// Superset of every capability's required params so a declared id can be
// dispatched without tripping its own param validation.
const RICH_PARAMS = {
  taskId: "task-1",
  sessionId: "sess-1",
  content: "hello",
  title: "Parity task",
  goal: "prove parity",
  passed: true,
};

describe("orchestrator capability manifest↔dispatch parity", () => {
  it("the view manifest declares exactly the ids in the dispatch gate set", () => {
    const manifest = manifestCapabilityIds();
    expect(manifest.size).toBeGreaterThan(0);
    expect(ORCHESTRATOR_CAPABILITY_IDS.size).toBeGreaterThan(0);
    expect([...manifest].sort()).toEqual(
      [...ORCHESTRATOR_CAPABILITY_IDS].sort(),
    );
  });

  it("every declared id is really handled by runOrchestratorCapability (no fall-through)", async () => {
    for (const id of ORCHESTRATOR_CAPABILITY_IDS) {
      // A declared-but-unhandled id would throw the dispatcher's
      // unknown-capability error; anything else (including a param-validation
      // error) proves the id has a real case.
      await expect(
        runOrchestratorCapability(id, RICH_PARAMS),
        id,
      ).resolves.toBeDefined();
    }
  });

  it("an undeclared id falls through to the explicit unknown-capability error", async () => {
    await expect(
      runOrchestratorCapability("orchestrator-not-a-capability"),
    ).rejects.toThrow(/does not support "orchestrator-not-a-capability"/);
  });
});
