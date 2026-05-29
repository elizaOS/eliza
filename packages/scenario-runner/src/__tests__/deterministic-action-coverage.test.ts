import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@elizaos/core";
import { describe, expect, it } from "vitest";

/**
 * Deterministic action-coverage gate.
 *
 * The app exposes an action surface that we want fully exercised by zero-cost
 * (keyless) e2e scenarios in CI. This test is the registry + ratchet that keeps
 * that promise honest:
 *
 *   1. The real action surface of each importable core plugin is read live (by
 *      importing the plugin and reading `plugin.actions[].name`) and must match
 *      the checked-in manifest exactly. A new/renamed/removed action breaks the
 *      build, forcing whoever changed it to acknowledge the action here.
 *   2. The set of actions that actually have a deterministic scenario is derived
 *      from the real scenario corpus (`actionName:` literals in
 *      `test/scenarios/*.scenario.ts`) — it cannot be faked by editing a list.
 *   3. Every core action is either covered (with a real scenario) or listed in
 *      KNOWN_UNCOVERED. That baseline may only shrink: covering an action forces
 *      its removal here, and adding a new uncovered action forces an entry.
 *
 * Plugins whose action surface needs live credentials, a real browser, or a
 * local model are documented in LIVE_ONLY_PLUGINS and excluded from the keyless
 * ratchet — enumerating their ~190 actions here would be churn, not coverage.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scenarioDir = resolve(repoRoot, "packages/scenario-runner/test/scenarios");

/**
 * Core plugins whose action surface is read live by importing the package.
 * Values are the expected action names — kept in lockstep with the real plugin
 * by the "core plugin action surface matches manifest" test below.
 */
const CORE_ACTION_SURFACE: Record<string, readonly string[]> = {
  "@elizaos/plugin-app-control": ["APP", "VIEWS"],
  "@elizaos/plugin-coding-tools": ["FILE", "SHELL", "WORKTREE"],
  "@elizaos/plugin-agent-skills": [
    "SKILL",
    "SKILL_DETAILS",
    "SKILL_INSTALL",
    "SKILL_SEARCH",
    "SKILL_SYNC",
    "SKILL_TOGGLE",
    "SKILL_UNINSTALL",
    "USE_SKILL",
  ],
  "@elizaos/plugin-local-inference": ["GENERATE_MEDIA"],
};

/** Core plugins that intentionally expose no agent actions (service/registry only). */
const ACTIONLESS_CORE_PLUGINS = [
  "@elizaos/plugin-shell",
  "@elizaos/plugin-commands",
  "@elizaos/plugin-video",
  "@elizaos/plugin-device-filesystem",
] as const;

/**
 * Core plugins whose action lives behind heavy UI deps that cannot be imported
 * under node (e.g. companion's VRM/Three.js stack). Verified by source instead.
 */
const SOURCE_ONLY_ACTIONS: Record<string, readonly string[]> = {
  "plugins/plugin-companion/src/actions/emote.ts": ["PLAY_EMOTE"],
};

/**
 * Plugins excluded from the keyless ratchet because their actions require live
 * credentials, a real browser, or a local model. Documented for honesty; the
 * keyless mock LLM cannot stand in for these without faking the integration.
 */
const LIVE_ONLY_PLUGINS: Record<string, string> = {
  "@elizaos/plugin-google": "Requires Google OAuth credentials.",
  "@elizaos/plugin-lifeops":
    "~150 actions across connectors needing live creds (Gmail, calendar, messaging, owner data).",
  "@elizaos/plugin-browser":
    "37 actions requiring a real Chromium session or browser bridge.",
};

/**
 * Core actions that do NOT yet have a deterministic scenario. This baseline may
 * only shrink. When you add a scenario for one of these, delete it from here.
 * When you add a new core action, either cover it or add it here.
 */
const KNOWN_UNCOVERED: readonly string[] = [
  "FILE",
  "GENERATE_MEDIA",
  "PLAY_EMOTE",
  "SHELL",
  "SKILL",
  "SKILL_DETAILS",
  "SKILL_INSTALL",
  "SKILL_SEARCH",
  "SKILL_SYNC",
  "SKILL_TOGGLE",
  "SKILL_UNINSTALL",
  "USE_SKILL",
  "WORKTREE",
];

function collectActionNames(mod: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const value of Object.values(mod)) {
    if (
      value &&
      typeof value === "object" &&
      Array.isArray((value as Plugin).actions)
    ) {
      for (const action of (value as Plugin).actions ?? []) {
        if (action && typeof action.name === "string") names.add(action.name);
      }
    }
  }
  return [...names].sort();
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function scenarioActionNames(): string[] {
  const names = new Set<string>();
  const pattern = /actionName:\s*"([A-Za-z_]+)"/g;
  for (const file of readdirSync(scenarioDir)) {
    if (!file.endsWith(".scenario.ts")) continue;
    const source = readFileSync(resolve(scenarioDir, file), "utf8");
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return sorted(names);
}

function allCoreActions(): string[] {
  return sorted([
    ...Object.values(CORE_ACTION_SURFACE).flat(),
    ...Object.values(SOURCE_ONLY_ACTIONS).flat(),
  ]);
}

describe("deterministic action coverage", () => {
  it("core plugin action surface matches the live imports (no drift, new actions caught)", async () => {
    const drift: string[] = [];
    for (const [spec, expected] of Object.entries(CORE_ACTION_SURFACE)) {
      let actual: string[];
      try {
        const mod = (await import(spec)) as Record<string, unknown>;
        actual = collectActionNames(mod);
      } catch (error) {
        drift.push(
          `${spec}: failed to import — ${String((error as Error)?.message).split("\n")[0]}`,
        );
        continue;
      }
      const want = sorted(expected);
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        drift.push(
          `${spec}: real actions [${actual.join(", ")}] != manifest [${want.join(", ")}] — update CORE_ACTION_SURFACE and classify any new action`,
        );
      }
    }
    expect(drift, drift.join("\n")).toEqual([]);
  });

  it("service/registry core plugins expose no agent actions", async () => {
    const unexpected: string[] = [];
    for (const spec of ACTIONLESS_CORE_PLUGINS) {
      const mod = (await import(spec)) as Record<string, unknown>;
      const actions = collectActionNames(mod);
      if (actions.length > 0) {
        unexpected.push(`${spec}: now exposes [${actions.join(", ")}]`);
      }
    }
    expect(unexpected, unexpected.join("\n")).toEqual([]);
  });

  it("source-only plugin actions are present in source", () => {
    const missing: string[] = [];
    for (const [relPath, actions] of Object.entries(SOURCE_ONLY_ACTIONS)) {
      const source = readFileSync(resolve(repoRoot, relPath), "utf8");
      for (const action of actions) {
        if (!source.includes(`name: "${action}"`)) {
          missing.push(`${relPath}:${action}`);
        }
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("deterministic coverage is derived from the real scenario corpus", () => {
    const covered = scenarioActionNames();
    const known = new Set(allCoreActions());
    // Anti-larp: a scenario must not claim to drive an action that no core
    // plugin exposes (live-only actions are tested live, not here).
    const phantom = covered.filter((name) => !known.has(name));
    expect(
      phantom,
      `scenarios reference unknown/non-core actions: ${phantom.join(", ")}`,
    ).toEqual([]);
  });

  it("every core action is covered by a scenario or in the shrinking baseline", () => {
    const covered = new Set(scenarioActionNames());
    const uncovered = allCoreActions().filter((name) => !covered.has(name));
    const baseline = sorted(KNOWN_UNCOVERED);

    // The baseline must match the real uncovered set exactly: covering an
    // action forces its removal here; a new uncovered action forces an entry.
    expect(
      sorted(uncovered),
      `uncovered core actions drifted from KNOWN_UNCOVERED.\n` +
        `  real uncovered: ${sorted(uncovered).join(", ") || "(none)"}\n` +
        `  baseline:       ${baseline.join(", ") || "(none)"}`,
    ).toEqual(baseline);

    // Anti-larp: nothing in the baseline may be a fake action name.
    const known = new Set(allCoreActions());
    const fake = baseline.filter((name) => !known.has(name));
    expect(fake, `baseline lists non-existent actions: ${fake.join(", ")}`).toEqual(
      [],
    );
  });

  it("documents live-only plugins that are intentionally outside the keyless ratchet", () => {
    for (const reason of Object.values(LIVE_ONLY_PLUGINS)) {
      expect(reason.length).toBeGreaterThan(0);
    }
    // Live-only plugins must not also appear in the keyless surface.
    const overlap = Object.keys(LIVE_ONLY_PLUGINS).filter(
      (spec) => spec in CORE_ACTION_SURFACE,
    );
    expect(overlap, `plugin both keyless and live-only: ${overlap.join(", ")}`).toEqual(
      [],
    );
  });
});
