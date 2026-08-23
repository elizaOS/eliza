/**
 * Per-scenario action scoping for the shared scenario runtime.
 *
 * PGLite cannot be torn down and rebuilt between scenarios, so one CLI
 * invocation runs every scenario against one `AgentRuntime`. The CLI registers
 * the union of every loaded scenario's `requires.plugins` into that runtime
 * before the first scenario starts, and a scenario's own seed may register
 * more. Both accumulate: without scoping, the action planner is offered the
 * union of every batched scenario's actions, so the tool surface a scenario
 * observes depends on which *other* scenarios happen to share the process.
 *
 * That is not a cosmetic difference. Strict deterministic model fixtures match
 * on the exact tool-name set (`DeterministicModelFixtureMatch.toolNames`), so a
 * peer's action silently turns a passing scenario red — the scenario stops
 * routing, replies instead of acting, and its own fixtures report zero
 * consumption. This module restores batch independence by hiding, for the
 * lifetime of one scenario, every action contributed by a batch peer's declared
 * plugin that this scenario did not declare, and by restoring the runtime's
 * action list afterwards so a scenario's seed-registered actions do not leak
 * forward either.
 */

import type { Action, AgentRuntime } from "@elizaos/core";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import {
  pluginMatchesScenarioPackage,
  resolveRequiredPluginPackages,
} from "./required-plugins.ts";

/** The narrow runtime surface this scoping needs. */
export type ActionScopedRuntime = Pick<AgentRuntime, "actions" | "plugins">;

function actionNamesForPackages(
  runtime: ActionScopedRuntime,
  packageNames: readonly string[],
): Set<string> {
  const names = new Set<string>();
  if (packageNames.length === 0) return names;
  for (const plugin of runtime.plugins) {
    if (
      !packageNames.some((packageName) =>
        pluginMatchesScenarioPackage(plugin, packageName),
      )
    ) {
      continue;
    }
    for (const action of (plugin.actions ?? []) as Action[]) {
      if (typeof action?.name === "string") names.add(action.name);
    }
  }
  return names;
}

/**
 * Action names contributed only by plugins that a *peer* scenario in this batch
 * declared. An action that this scenario's own declared plugins also provide is
 * never hidden, so overlapping declarations stay visible.
 */
export function foreignScenarioActionNames(
  runtime: ActionScopedRuntime,
  scenario: ScenarioDefinition,
  batchPluginPackages: readonly string[],
  scenarioDeclaredActionNames?: readonly string[],
): Set<string> {
  const declared = resolveRequiredPluginPackages(scenario);
  const declaredSet = new Set(declared);
  const foreignPackages = batchPluginPackages.filter(
    (packageName) => !declaredSet.has(packageName),
  );
  const foreign = actionNamesForPackages(runtime, foreignPackages);
  for (const name of actionNamesForPackages(runtime, declared)) {
    foreign.delete(name);
  }
  // A package a peer declared may also be part of the runtime's baseline, and
  // a scenario is entitled to every baseline action whether or not it declared
  // the owning package. Hiding those broke scenarios that legitimately drive a
  // baseline action without a `requires.plugins` entry, so restrict the hidden
  // set to the actions that exist solely because of a scenario declaration.
  if (scenarioDeclaredActionNames) {
    const scenarioOnly = new Set(scenarioDeclaredActionNames);
    for (const name of [...foreign]) {
      if (!scenarioOnly.has(name)) foreign.delete(name);
    }
  }
  return foreign;
}

/**
 * Scope the runtime's action list to this scenario and return the restore
 * callback. The restore reinstates the exact pre-scenario action list, which
 * both re-exposes hidden peer actions and drops actions registered by this
 * scenario's seed.
 */
export function enterScenarioActionScope(
  runtime: ActionScopedRuntime,
  scenario: ScenarioDefinition,
  batchPluginPackages: readonly string[],
  scenarioDeclaredActionNames?: readonly string[],
): { hiddenActionNames: string[]; restore: () => void } {
  const snapshot = [...runtime.actions];
  const hidden = foreignScenarioActionNames(
    runtime,
    scenario,
    batchPluginPackages,
    scenarioDeclaredActionNames,
  );
  if (hidden.size > 0) {
    const kept = snapshot.filter((action) => !hidden.has(action.name));
    runtime.actions.splice(0, runtime.actions.length, ...kept);
  }
  return {
    hiddenActionNames: [...hidden].sort(),
    restore: () => {
      runtime.actions.splice(0, runtime.actions.length, ...snapshot);
    },
  };
}
