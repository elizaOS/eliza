/**
 * Covers per-scenario action scoping on the shared scenario runtime: the unit
 * contract of `scenario-action-scope.ts`, and an end-to-end regression that
 * drives two scenarios through the real `runScenario` in one process against
 * one runtime — the exact shape that used to let a batch peer's plugin change
 * the second scenario's planner tool surface and starve its model fixtures.
 * The runtime is a lightweight fake; the fixture registry is the real one from
 * `@elizaos/core/testing`.
 */

import type { Action, AgentRuntime, Plugin } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { createDeterministicModelPlugin } from "@elizaos/core/testing";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it, vi } from "vitest";
import { runScenario } from "./executor.ts";
import {
  enterScenarioActionScope,
  foreignScenarioActionNames,
} from "./scenario-action-scope.ts";

function action(name: string): Action {
  return {
    name,
    description: name,
    examples: [],
    validate: async () => true,
    handler: async () => undefined,
  } as unknown as Action;
}

function plugin(name: string, actionNames: string[]): Plugin {
  return {
    name,
    description: name,
    actions: actionNames.map(action),
  } as unknown as Plugin;
}

function scenarioDeclaring(id: string, packages: string[]): ScenarioDefinition {
  return {
    id,
    title: id,
    domain: "scenario-runner",
    requires: { plugins: packages },
    turns: [],
  } as unknown as ScenarioDefinition;
}

describe("foreignScenarioActionNames", () => {
  const runtime = {
    actions: [],
    plugins: [
      plugin("coding-tools", ["FILE", "SHELL", "WORKTREE"]),
      plugin("app-control", ["APP", "VIEWS"]),
      plugin("bootstrap", ["REPLY", "IGNORE"]),
    ],
  } as unknown as Parameters<typeof foreignScenarioActionNames>[0];

  it("names only the actions a batch peer's declared plugin contributed", () => {
    const hidden = foreignScenarioActionNames(
      runtime,
      scenarioDeclaring("coding", ["@elizaos/plugin-coding-tools"]),
      ["@elizaos/plugin-coding-tools", "@elizaos/plugin-app-control"],
    );
    expect([...hidden].sort()).toEqual(["APP", "VIEWS"]);
  });

  it("never hides an action the scenario's own declared plugin provides", () => {
    const shared = {
      actions: [],
      plugins: [
        plugin("coding-tools", ["FILE"]),
        plugin("app-control", ["FILE", "APP"]),
      ],
    } as unknown as Parameters<typeof foreignScenarioActionNames>[0];
    const hidden = foreignScenarioActionNames(
      shared,
      scenarioDeclaring("coding", ["@elizaos/plugin-coding-tools"]),
      ["@elizaos/plugin-coding-tools", "@elizaos/plugin-app-control"],
    );
    expect([...hidden].sort()).toEqual(["APP"]);
  });

  it("never hides a baseline action, even when a peer declared its package", () => {
    // plugin-browser is both a runtime baseline capability and something some
    // scenarios declare. A scenario that drives BROWSER without declaring the
    // package must keep it; only actions that exist *because* of a declaration
    // may be hidden.
    const hidden = foreignScenarioActionNames(
      runtime,
      scenarioDeclaring("coding", ["@elizaos/plugin-coding-tools"]),
      ["@elizaos/plugin-coding-tools", "@elizaos/plugin-app-control"],
      // Only APP exists because a scenario declared app-control; VIEWS is a
      // baseline action the runtime carries either way.
      ["APP"],
    );
    expect([...hidden]).toEqual(["APP"]);
  });

  it("hides nothing when the runtime carries no peer declarations", () => {
    const hidden = foreignScenarioActionNames(
      runtime,
      scenarioDeclaring("coding", ["@elizaos/plugin-coding-tools"]),
      ["@elizaos/plugin-coding-tools"],
    );
    expect([...hidden]).toEqual([]);
  });
});

describe("enterScenarioActionScope", () => {
  it("hides peer actions for the scope and restores the exact prior list", () => {
    const runtime = {
      actions: [action("FILE"), action("APP"), action("REPLY")],
      plugins: [
        plugin("coding-tools", ["FILE"]),
        plugin("app-control", ["APP"]),
      ],
    } as unknown as Parameters<typeof enterScenarioActionScope>[0];

    const scope = enterScenarioActionScope(
      runtime,
      scenarioDeclaring("coding", ["@elizaos/plugin-coding-tools"]),
      ["@elizaos/plugin-coding-tools", "@elizaos/plugin-app-control"],
    );
    expect(runtime.actions.map((entry) => entry.name)).toEqual([
      "FILE",
      "REPLY",
    ]);
    expect(scope.hiddenActionNames).toEqual(["APP"]);

    scope.restore();
    expect(runtime.actions.map((entry) => entry.name)).toEqual([
      "FILE",
      "APP",
      "REPLY",
    ]);
  });

  it("drops actions registered inside the scope so they cannot leak forward", () => {
    const runtime = {
      actions: [action("REPLY")],
      plugins: [],
    } as unknown as Parameters<typeof enterScenarioActionScope>[0];

    const scope = enterScenarioActionScope(
      runtime,
      scenarioDeclaring("seeded", []),
      [],
    );
    runtime.actions.push(action("SEED_ONLY"));
    scope.restore();
    expect(runtime.actions.map((entry) => entry.name)).toEqual(["REPLY"]);
  });
});

/**
 * The regression that matters: two scenarios, one process, one runtime. The
 * runtime carries both scenarios' plugins because the CLI registers the batch
 * union before the first scenario starts. The second scenario must observe the
 * same action surface it would observe alone, and its own model fixtures must
 * be consumed.
 */
describe("two scenarios sharing one runtime", () => {
  function createSharedRuntime(): {
    runtime: AgentRuntime;
    callPlanner: (prompt: string, toolNames: string[]) => Promise<unknown>;
  } {
    const codingTools = plugin("coding-tools", ["FILE"]);
    const appControl = plugin("app-control", ["APP"]);
    const deterministic = createDeterministicModelPlugin();
    const runtime = {
      actions: [...(codingTools.actions ?? []), ...(appControl.actions ?? [])],
      plugins: [codingTools, appControl],
      routes: [],
      ensureConnection: vi.fn(async () => undefined),
      getService: vi.fn(() => null),
      setSetting: vi.fn(),
      scenarioModelFixtures: deterministic.fixtures,
      assertScenarioModelFixturesConsumed: deterministic.assertFixturesConsumed,
      getScenarioModelFixtureDiagnostics: deterministic.getFixtureDiagnostics,
      setScenarioModelFixtureMode: vi.fn(),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as unknown as AgentRuntime;
    const handler = deterministic.models?.[ModelType.ACTION_PLANNER] as (
      runtime: unknown,
      params: unknown,
    ) => Promise<unknown>;
    return {
      runtime,
      callPlanner: (prompt, toolNames) =>
        handler(runtime, {
          prompt,
          tools: toolNames.map((name) => ({ name, parameters: {} })),
        }),
    };
  }

  /**
   * A scenario whose seed records the action surface it can see and consumes
   * one strict fixture that matches on the exact tool-name set — the same
   * `toolNames` match the real deterministic corpus uses.
   */
  function observingScenario(
    id: string,
    declaredPackages: string[],
    observedToolNames: string[],
    seen: string[][],
    callPlanner: (prompt: string, toolNames: string[]) => Promise<unknown>,
  ): ScenarioDefinition {
    return {
      id,
      title: id,
      domain: "scenario-runner",
      lane: "pr-deterministic",
      requires: { plugins: declaredPackages },
      modelFixtures: {
        mode: "fixtures",
        fixtures: [
          {
            name: `${id}-planner`,
            match: {
              modelType: "ACTION_PLANNER",
              toolNames: observedToolNames,
            },
            response: { text: "ok" },
          },
        ],
      },
      seed: [
        {
          type: "custom",
          name: "observe the visible action surface",
          apply: async (ctx: { runtime?: unknown }) => {
            const visible = (
              ctx.runtime as { actions: Array<{ name: string }> }
            ).actions.map((entry) => entry.name);
            seen.push(visible);
            await callPlanner(id, visible);
            return undefined;
          },
        },
      ],
      turns: [],
    } as unknown as ScenarioDefinition;
  }

  it("gives the second scenario a solo action surface and consumes its fixtures", async () => {
    const { runtime, callPlanner } = createSharedRuntime();
    const seen: string[][] = [];
    const batch = [
      "@elizaos/plugin-app-control",
      "@elizaos/plugin-coding-tools",
    ];
    const options = {
      providerName: "deterministic-model-provider",
      minJudgeScore: 0,
      turnTimeoutMs: 5_000,
      batchPluginPackages: batch,
    };

    const first = await runScenario(
      observingScenario(
        "peer-app-control",
        ["@elizaos/plugin-app-control"],
        ["APP"],
        seen,
        callPlanner,
      ),
      runtime,
      options,
    );
    const second = await runScenario(
      observingScenario(
        "coding-tools-under-test",
        ["@elizaos/plugin-coding-tools"],
        ["FILE"],
        seen,
        callPlanner,
      ),
      runtime,
      options,
    );

    // Neither scenario may see the other's action.
    expect(seen[0]).toEqual(["APP"]);
    expect(seen[1]).toEqual(["FILE"]);

    // The second scenario's own fixtures were consumed — the failure this
    // guards reported `consumed: 0` for every fixture it declared.
    const fixtures = second.modelFixtureDiagnostics?.fixtures ?? [];
    expect(fixtures.map((entry) => entry.name)).toEqual([
      "coding-tools-under-test-planner",
    ]);
    expect(fixtures.every((entry) => entry.consumed >= entry.min)).toBe(true);
    expect(second.modelFixtureDiagnostics?.unexpectedCalls ?? []).toEqual([]);

    expect(first.failedAssertions).toEqual([]);
    expect(second.failedAssertions).toEqual([]);

    // The runtime is handed back intact for whatever runs next.
    expect(runtime.actions.map((entry) => entry.name).sort()).toEqual([
      "APP",
      "FILE",
    ]);
  });
});
