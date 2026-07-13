/**
 * Exercises the checked-in live-scenario shard manifest and its GitHub matrix
 * selector without substituting a second test-only source of shard truth.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScenarioWorkflowCoverage } from "../check-scenario-workflow-coverage.mjs";
import {
  LIVE_SCENARIO_CREDENTIAL_PROFILES,
  LIVE_SCENARIO_MANIFEST_PATH,
  loadLiveScenarioManifest,
  selectLiveScenarioShards,
  validateLiveScenarioManifest,
} from "../live-scenario-matrix.mjs";

const scriptPath = fileURLToPath(
  new URL("../live-scenario-matrix.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("live scenario matrix", () => {
  test("loads the canonical authority and every consolidated shard", () => {
    const manifest = loadLiveScenarioManifest();

    expect(LIVE_SCENARIO_MANIFEST_PATH).toEndWith(
      "packages/scripts/live-scenario-shards.json",
    );
    expect(manifest.authority).toBe(".github/workflows/live-scenarios.yml");
    expect(manifest.shards.map((shard) => shard.name)).toEqual([
      "executive-connectors",
      "messaging",
      "todos-reminders",
      "calendar",
      "relationships",
      "browser-social",
      "personality-payments",
      "cross-cutting-gateway",
      "lifeops-app",
      "plugin-health",
      "app-control",
    ]);
    expect(
      manifest.shards.find((shard) => shard.name === "lifeops-app")?.root,
    ).toBe("plugins/plugin-personal-assistant/test/scenarios");
    expect(
      Object.fromEntries(
        manifest.shards.map((shard) => [shard.name, shard.credentialProfiles]),
      ),
    ).toEqual({
      "executive-connectors": [
        "model",
        "google-workspace",
        "calendly",
        "discord",
        "telegram",
        "signal",
        "imessage",
        "bluebubbles",
        "whatsapp",
        "twilio",
        "twitter",
        "notifications",
        "travel",
      ],
      messaging: [
        "model",
        "google-workspace",
        "discord",
        "telegram",
        "signal",
        "whatsapp",
        "twitter",
      ],
      "todos-reminders": ["model"],
      calendar: ["model", "google-workspace", "calendly"],
      relationships: ["model"],
      "browser-social": ["model", "twitter", "onepassword"],
      "personality-payments": ["model", "elizacloud"],
      "cross-cutting-gateway": LIVE_SCENARIO_CREDENTIAL_PROFILES.filter(
        (profile) => !["twitter", "github", "onepassword"].includes(profile),
      ),
      "lifeops-app": ["model", "google-workspace"],
      "plugin-health": ["model"],
      "app-control": ["model"],
    });
  });

  test("selects either the full scheduled matrix or one manual shard", () => {
    const manifest = loadLiveScenarioManifest();

    expect(selectLiveScenarioShards(manifest)).toHaveLength(11);
    expect(selectLiveScenarioShards(manifest, "calendar")).toEqual([
      manifest.shards[3],
    ]);
    expect(() => selectLiveScenarioShards(manifest, "missing")).toThrow(
      /unknown live scenario shard/,
    );
  });

  test("rejects duplicate, escaping, and out-of-root shard declarations", () => {
    const base = {
      schema: "eliza_live_scenario_shards_v2",
      authority: ".github/workflows/live-scenarios.yml",
      shards: [
        {
          name: "valid",
          root: "packages/test/scenarios",
          globs: ["packages/test/scenarios/calendar/**/*.scenario.ts"],
          credentialProfiles: ["model"],
        },
      ],
    };

    expect(() =>
      validateLiveScenarioManifest(
        { ...base, shards: [...base.shards, ...base.shards] },
        { requirePaths: false },
      ),
    ).toThrow(/duplicate live scenario shard/);
    expect(() =>
      validateLiveScenarioManifest(
        {
          ...base,
          shards: [{ ...base.shards[0], root: "../outside" }],
        },
        { requirePaths: false },
      ),
    ).toThrow(/escapes the repository/);
    expect(() =>
      validateLiveScenarioManifest(
        {
          ...base,
          shards: [
            {
              ...base.shards[0],
              globs: ["plugins/plugin-health/test/scenarios/**/*.scenario.ts"],
            },
          ],
        },
        { requirePaths: false },
      ),
    ).toThrow(/must stay beneath/);
  });

  test("rejects missing, unknown, duplicate, and model-less credential profiles", () => {
    const shard = {
      name: "valid",
      root: "packages/test/scenarios",
      globs: ["packages/test/scenarios/calendar/**/*.scenario.ts"],
      credentialProfiles: ["model"],
    };
    const manifest = {
      schema: "eliza_live_scenario_shards_v2",
      authority: ".github/workflows/live-scenarios.yml",
      shards: [shard],
    };

    expect(() =>
      validateLiveScenarioManifest(
        { ...manifest, shards: [{ ...shard, credentialProfiles: undefined }] },
        { requirePaths: false },
      ),
    ).toThrow(/must declare credential profiles/);
    expect(() =>
      validateLiveScenarioManifest(
        {
          ...manifest,
          shards: [{ ...shard, credentialProfiles: ["unknown"] }],
        },
        { requirePaths: false },
      ),
    ).toThrow(/unknown credential profile/);
    expect(() =>
      validateLiveScenarioManifest(
        {
          ...manifest,
          shards: [{ ...shard, credentialProfiles: ["model", "model"] }],
        },
        { requirePaths: false },
      ),
    ).toThrow(/duplicate credential profile/);
    expect(() =>
      validateLiveScenarioManifest(
        {
          ...manifest,
          shards: [{ ...shard, credentialProfiles: ["calendar"] }],
        },
        { requirePaths: false },
      ),
    ).toThrow(/unknown credential profile/);
    expect(() =>
      validateLiveScenarioManifest(
        {
          ...manifest,
          shards: [{ ...shard, credentialProfiles: ["google-workspace"] }],
        },
        { requirePaths: false },
      ),
    ).toThrow(/must include the model credential profile/);
  });

  test("emits one-line matrix JSON through the real GitHub output boundary", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "live-matrix-"));
    temporaryDirectories.push(directory);
    const outputPath = path.join(directory, "github-output.txt");
    const completed = spawnSync(
      process.execPath,
      [scriptPath, "--shard", "calendar", "--github-output"],
      {
        env: { ...process.env, GITHUB_OUTPUT: outputPath },
        encoding: "utf8",
      },
    );

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe("");
    const line = readFileSync(outputPath, "utf8").trim();
    const matrix = JSON.parse(line.replace(/^matrix=/, "")) as {
      shard: Array<{
        name: string;
        root: string;
        globs: string[];
        credentialProfiles: string[];
      }>;
    };
    expect(matrix.shard).toHaveLength(1);
    expect(matrix.shard[0]?.name).toBe("calendar");
    expect(matrix.shard[0]?.credentialProfiles).toEqual([
      "model",
      "google-workspace",
      "calendly",
    ]);
  });

  test("covers every runnable live catalog entry exactly once", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "live-coverage-"));
    temporaryDirectories.push(directory);
    const reportDirectory = path.join(directory, "catalog");
    const exitCode = runScenarioWorkflowCoverage([
      "--report-dir",
      reportDirectory,
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(
      readFileSync(
        path.join(reportDirectory, "workflow-coverage.json"),
        "utf8",
      ),
    ) as {
      defaultScenarioCount: number;
      coveredDefaultCount: number;
      deferredDefaultIds: string[];
      liveScenarioAuthority: string;
      missingLiveScenarioRoots: string[];
      emptyLiveScenarioGlobs: string[];
      duplicateLiveScenarioIds: string[];
      missingLiveScenarioIds: string[];
    };
    expect(summary.liveScenarioAuthority).toBe(
      ".github/workflows/live-scenarios.yml",
    );
    expect(
      summary.coveredDefaultCount + summary.deferredDefaultIds.length,
    ).toBe(summary.defaultScenarioCount);
    expect(summary.missingLiveScenarioRoots).toEqual([]);
    expect(summary.emptyLiveScenarioGlobs).toEqual([]);
    expect(summary.duplicateLiveScenarioIds).toEqual([]);
    expect(summary.missingLiveScenarioIds).toEqual([]);
  }, 15_000);
});
