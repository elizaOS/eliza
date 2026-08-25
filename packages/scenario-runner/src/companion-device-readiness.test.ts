/**
 * Pins the readiness barrier of the `deterministic-companion-device` scenario.
 *
 * Its seed registers the companion plugin, but `registerPlugin` is not a
 * readiness barrier: core registers plugin services lazily and starts them
 * fire-and-forget (packages/core/src/runtime.ts). Both companion actions
 * validate on nothing but "is the COMPANION service live?", so a duration-based
 * handshake wait turns a slow host into a validation rejection. These tests run
 * the scenario's real `until` predicate against a structural runtime and prove
 * it is a state barrier: false while the service is absent, false while it is
 * present but pre-handshake, true only once it reports ready.
 *
 * The scenario is loaded at runtime rather than statically imported: it runs on
 * Bun globals and an unmapped workspace specifier, neither of which this
 * package's tsconfig program (`include: src/**`) covers.
 */

import type {
  ScenarioContext,
  ScenarioDefinition,
} from "@elizaos/scenario-runner/schema";
import { beforeAll, describe, expect, it } from "vitest";

const READINESS_TURN_NAME =
  "companion service is live and the device handshake completed";

let companionScenario: ScenarioDefinition;

beforeAll(async () => {
  const specifier = new URL(
    "../test/scenarios/deterministic-companion-device.scenario.ts",
    import.meta.url,
  ).href;
  const loaded = (await import(/* @vite-ignore */ specifier)) as {
    default: ScenarioDefinition;
  };
  companionScenario = loaded.default;
});

function readinessPredicate(): (
  ctx: ScenarioContext,
) => boolean | Promise<boolean> {
  const definition = companionScenario;
  const turn = definition.turns.find(
    (candidate) => candidate.name === READINESS_TURN_NAME,
  );
  if (!turn) {
    throw new Error(`readiness turn "${READINESS_TURN_NAME}" is missing`);
  }
  if (turn.kind !== "wait") {
    throw new Error("the companion readiness turn must be a wait turn");
  }
  if (typeof turn.until !== "function") {
    throw new Error(
      "the companion readiness turn must poll an `until` state predicate, not sleep for a fixed duration",
    );
  }
  return turn.until;
}

function contextWithService(service: unknown): ScenarioContext {
  return {
    runtime: {
      getService(serviceType: string): unknown {
        return serviceType === "COMPANION" ? service : null;
      },
    },
    actionsCalled: [],
  } as unknown as ScenarioContext;
}

describe("deterministic-companion-device readiness barrier", () => {
  it("is a bounded state predicate, not a fixed sleep", () => {
    const definition = companionScenario;
    const turn = definition.turns.find(
      (candidate) => candidate.name === READINESS_TURN_NAME,
    );
    expect(turn?.kind).toBe("wait");
    expect(typeof turn?.until).toBe("function");
    expect(turn?.durationMs).toBeUndefined();
    expect(turn?.timeoutMs).toBeGreaterThan(0);
  });

  it("stays false while the lazily-started COMPANION service is absent", async () => {
    expect(await readinessPredicate()(contextWithService(null))).toBe(false);
  });

  it("stays false while the service exists but the device handshake has not completed", async () => {
    const predicate = readinessPredicate();
    expect(await predicate(contextWithService({ isReady: () => false }))).toBe(
      false,
    );
  });

  it("turns true only once the service reports a completed handshake", async () => {
    const predicate = readinessPredicate();
    let ready = false;
    const ctx = contextWithService({ isReady: () => ready });
    expect(await predicate(ctx)).toBe(false);
    ready = true;
    expect(await predicate(ctx)).toBe(true);
  });
});
