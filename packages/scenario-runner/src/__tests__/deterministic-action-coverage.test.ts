import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@elizaos/core";
import agentSkillsPlugin from "@elizaos/plugin-agent-skills";
import appControlPlugin from "@elizaos/plugin-app-control";
import codingToolsPlugin from "@elizaos/plugin-coding-tools";
import commandsPlugin from "@elizaos/plugin-commands";
import deviceFilesystemPlugin from "@elizaos/plugin-device-filesystem";
import localInferencePlugin from "@elizaos/plugin-local-inference";
import shellPlugin from "@elizaos/plugin-shell";
import videoPlugin from "@elizaos/plugin-video";
import { describe, expect, it } from "vitest";

/**
 * Deterministic action-coverage gate.
 *
 * The app exposes an action surface that we want exercised by zero-cost
 * (keyless) e2e scenarios in CI. This test keeps that promise honest:
 *
 *   - Surface integrity: the real action surface of each importable core plugin
 *     is read live (from `plugin.actions[].name`) and must match the checked-in
 *     manifest. A new/renamed/removed action breaks the build, forcing whoever
 *     changed it to acknowledge the action here.
 *   - Coverage registry: every action we claim to cover deterministically must
 *     still be referenced by a real scenario (no silent coverage regression),
 *     and the total only grows (count ratchet).
 *   - Stable-core ratchet: every stable-core keyless action is either covered or
 *     in a baseline that may only shrink.
 *   - Wiring integrity: every scenario file is actually run by the deterministic
 *     CI script — a scenario that exists but never runs is larp.
 *
 * Plugins import is static (top of file) so the heavy source transform happens
 * at module load, not inside a test where it would race the per-test timeout.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scenarioDir = resolve(repoRoot, "packages/scenario-runner/test/scenarios");
const packageJsonPath = resolve(repoRoot, "packages/scenario-runner/package.json");

/** Stable core plugins whose action surface is read live by import. */
const IMPORTED_CORE_PLUGINS: Record<string, Plugin> = {
  "@elizaos/plugin-app-control": appControlPlugin,
  "@elizaos/plugin-coding-tools": codingToolsPlugin,
  "@elizaos/plugin-agent-skills": agentSkillsPlugin,
  "@elizaos/plugin-local-inference": localInferencePlugin,
};

/** Expected action names for each imported core plugin (verified against live imports). */
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
const ACTIONLESS_CORE_PLUGINS: Record<string, Plugin> = {
  "@elizaos/plugin-shell": shellPlugin,
  "@elizaos/plugin-commands": commandsPlugin,
  "@elizaos/plugin-video": videoPlugin,
  "@elizaos/plugin-device-filesystem": deviceFilesystemPlugin,
};

/**
 * Core plugin actions behind heavy UI deps that cannot be imported under node
 * (companion's VRM/Three.js stack). Verified by source instead.
 */
const SOURCE_ONLY_ACTIONS: Record<string, readonly string[]> = {
  "plugins/plugin-companion/src/actions/emote.ts": ["PLAY_EMOTE"],
};

/**
 * The stable-core keyless surface that the ratchet drives to completion: the
 * importable core plugins plus the source-only companion action. Big, volatile
 * surfaces (browser, lifeops) are NOT here — their coverage is tracked by the
 * coverage registry instead, so adding a lifeops scenario never has to edit a
 * 150-entry surface list.
 */
function stableCoreActions(): string[] {
  return sorted([
    ...Object.values(CORE_ACTION_SURFACE).flat(),
    ...Object.values(SOURCE_ONLY_ACTIONS).flat(),
  ]);
}

/**
 * Stable-core keyless actions that do NOT yet have a deterministic scenario.
 * This baseline may only shrink: cover one and delete it here; add a new
 * stable-core action and either cover it or add it here.
 */
const KNOWN_UNCOVERED: readonly string[] = [];

/**
 * Actions with deterministic keyless scenario coverage today. This is the
 * registry that must not regress: every entry must still be referenced by a
 * scenario. It includes actions from volatile plugins (browser web mode,
 * lifeops scheduled tasks) that are NOT in the stable-core surface above.
 */
const COVERED_ACTIONS: readonly string[] = [
  "APP",
  "BROWSER_CLICK",
  "BROWSER_CLOSE",
  "BROWSER_GET",
  "BROWSER_LIST_TABS",
  "BROWSER_OPEN",
  "BROWSER_SCREENSHOT",
  "BROWSER_TYPE",
  "BROWSER_WAIT",
  "FILE",
  "GENERATE_MEDIA",
  "PLAY_EMOTE",
  "SKILL",
  "SKILL_DETAILS",
  "SKILL_INSTALL",
  "SKILL_SEARCH",
  "SKILL_SYNC",
  "SKILL_TOGGLE",
  "SKILL_UNINSTALL",
  "SHELL",
  "SCHEDULED_TASKS",
  "USE_SKILL",
  "VIEWS",
  "WORKTREE",
];

/** Deterministic coverage only grows: distinct covered actions must stay >= this. */
const COVERED_FLOOR = COVERED_ACTIONS.length;

/**
 * Plugins whose remaining action surface needs live credentials, a real
 * browser, or a local model. Documented for honesty; the keyless mock LLM
 * cannot stand in for these without faking the integration. Note that browser
 * (web/JSDOM mode) and lifeops (scheduled tasks) ARE partially keyless-covered
 * — see COVERED_ACTIONS — so the reason describes only the remainder.
 */
const LIVE_ONLY_REMAINDER: Record<string, string> = {
  "@elizaos/plugin-google": "All actions require Google OAuth credentials.",
  "@elizaos/plugin-lifeops":
    "Beyond SCHEDULED_TASKS, actions need live connector creds (Gmail, calendar, messaging, owner data).",
  "@elizaos/plugin-browser":
    "Beyond web/JSDOM mode, actions need a real Chromium session or browser bridge.",
};

function collectActionNames(plugin: Plugin): string[] {
  return sorted((plugin.actions ?? []).map((action) => action.name));
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function scenarioFiles(): string[] {
  return readdirSync(scenarioDir).filter((file) => file.endsWith(".scenario.ts"));
}

function scenarioActionNames(): string[] {
  const names = new Set<string>();
  const pattern = /actionName:\s*"([A-Za-z_]+)"/g;
  for (const file of scenarioFiles()) {
    const source = readFileSync(resolve(scenarioDir, file), "utf8");
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return sorted(names);
}

function declaredScenarioId(file: string): string | null {
  const source = readFileSync(resolve(scenarioDir, file), "utf8");
  return (
    source.match(/export\s+default\s+scenario\(\{\s*id:\s*"([^"]+)"/s)?.[1] ??
    null
  );
}

function ciScenarioList(): string[] {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = pkg.scripts?.["test:deterministic:e2e"] ?? "";
  const arg = script.match(/--scenario\s+(\S+)/)?.[1] ?? "";
  return arg.split(",").filter(Boolean);
}

describe("deterministic action coverage", () => {
  it("stable-core plugin action surface matches the manifest (no drift, new actions caught)", () => {
    const drift: string[] = [];
    for (const [spec, plugin] of Object.entries(IMPORTED_CORE_PLUGINS)) {
      const actual = collectActionNames(plugin);
      const want = sorted(CORE_ACTION_SURFACE[spec] ?? []);
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        drift.push(
          `${spec}: real actions [${actual.join(", ")}] != manifest [${want.join(", ")}] — update CORE_ACTION_SURFACE and classify any new action`,
        );
      }
    }
    expect(drift, drift.join("\n")).toEqual([]);
  });

  it("service/registry core plugins expose no agent actions", () => {
    const unexpected: string[] = [];
    for (const [spec, plugin] of Object.entries(ACTIONLESS_CORE_PLUGINS)) {
      const actions = collectActionNames(plugin);
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

  it("every covered action still has a scenario (no coverage regression)", () => {
    const covered = new Set(scenarioActionNames());
    const regressed = sorted(COVERED_ACTIONS).filter((name) => !covered.has(name));
    expect(
      regressed,
      `actions in COVERED_ACTIONS no longer referenced by any scenario: ${regressed.join(", ")}`,
    ).toEqual([]);
  });

  it("deterministic coverage only grows (count ratchet)", () => {
    const distinct = scenarioActionNames().length;
    expect(
      distinct,
      `distinct covered actions dropped below the ratchet floor (${COVERED_FLOOR}); did a scenario get removed?`,
    ).toBeGreaterThanOrEqual(COVERED_FLOOR);
  });

  it("stable-core keyless actions are covered by a scenario or in the shrinking baseline", () => {
    const covered = new Set(scenarioActionNames());
    const uncovered = stableCoreActions().filter((name) => !covered.has(name));
    const baseline = sorted(KNOWN_UNCOVERED);

    expect(
      sorted(uncovered),
      `stable-core uncovered set drifted from KNOWN_UNCOVERED.\n` +
        `  real uncovered: ${sorted(uncovered).join(", ") || "(none)"}\n` +
        `  baseline:       ${baseline.join(", ") || "(none)"}`,
    ).toEqual(baseline);

    const known = new Set(stableCoreActions());
    const fake = baseline.filter((name) => !known.has(name));
    expect(
      fake,
      `baseline lists actions that are not in the stable-core surface: ${fake.join(", ")}`,
    ).toEqual([]);
  });

  it("every scenario file is wired into the deterministic CI run and named after its id", () => {
    const wired = new Set(ciScenarioList());
    const problems: string[] = [];
    for (const file of scenarioFiles()) {
      const base = file.replace(/\.scenario\.ts$/, "");
      const id = declaredScenarioId(file);
      if (id !== base) {
        problems.push(`${file}: declared id ${JSON.stringify(id)} != filename base ${JSON.stringify(base)}`);
      }
      if (!wired.has(base)) {
        problems.push(
          `${file}: not in test:deterministic:e2e --scenario list — wire it or it never runs in CI`,
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("documents the live-only remainder without overlapping the keyless surface", () => {
    for (const reason of Object.values(LIVE_ONLY_REMAINDER)) {
      expect(reason.length).toBeGreaterThan(0);
    }
    const overlap = Object.keys(LIVE_ONLY_REMAINDER).filter(
      (spec) => spec in IMPORTED_CORE_PLUGINS,
    );
    expect(
      overlap,
      `plugin both keyless-imported and live-only: ${overlap.join(", ")}`,
    ).toEqual([]);
  });
});
