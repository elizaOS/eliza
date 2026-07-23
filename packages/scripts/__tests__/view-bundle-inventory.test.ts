/**
 * Exercises dynamic-view discovery against synthetic workspace trees and the
 * real repository so missing, duplicate, unowned, and ambiguous targets fail.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseViewInventoryArgs } from "../audit-view-bundle-inventory.mjs";
import {
  discoverViewBundleInventory,
  selectViewBundleTargets,
  serializeViewBundleInventory,
} from "../lib/view-bundle-inventory.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "view-inventory-"));
  tempDirs.push(root);
  return root;
}

function addWorkspace(
  root: string,
  dir: string,
  options: {
    name?: string;
    config?: string;
    buildScript?: string;
  } = {},
) {
  const absoluteDir = path.join(root, dir);
  fs.mkdirSync(absoluteDir, { recursive: true });
  const config = options.config;
  if (config) fs.writeFileSync(path.join(absoluteDir, config), "export {};\n");
  return {
    name: options.name ?? `@fixture/${path.basename(dir)}`,
    dir,
    packageJson: {
      name: options.name ?? `@fixture/${path.basename(dir)}`,
      devDependencies: {
        vite: "^8.0.0",
      },
      scripts:
        options.buildScript === undefined
          ? {}
          : { "build:views": options.buildScript },
    },
  };
}

describe("dynamic-view build inventory", () => {
  test("discovers a nested workspace and supported config extension", () => {
    const root = makeRoot();
    const workspace = addWorkspace(root, "packages/nested/viewer", {
      config: "vite.config.views.mts",
      buildScript: "vite build --config vite.config.views.mts",
    });

    const inventory = discoverViewBundleInventory({
      repoRoot: root,
      workspacePackages: [workspace],
      repositoryFiles: ["packages\\nested\\viewer\\vite.config.views.mts"],
    });

    expect(inventory.configCount).toBe(1);
    expect(inventory.targets).toEqual([
      expect.objectContaining({
        name: "viewer",
        workspaceDir: "packages/nested/viewer",
        config: "packages/nested/viewer/vite.config.views.mts",
        bundle: "packages/nested/viewer/dist/views/bundle.js",
      }),
    ]);
  });

  test("rejects an unowned view config", () => {
    const root = makeRoot();
    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [],
        repositoryFiles: ["loose/vite.config.views.ts"],
      }),
    ).toThrow(/outside declared workspaces/);
  });

  test("rejects config and workspace case collisions", () => {
    const root = makeRoot();
    const workspace = addWorkspace(root, "plugins/viewer");
    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [workspace],
        repositoryFiles: [
          "plugins/viewer/vite.config.views.ts",
          "plugins/viewer/VITE.CONFIG.VIEWS.TS",
        ],
      }),
    ).toThrow(/case-colliding view configs/);

    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [workspace, { ...workspace, dir: "Plugins/Viewer" }],
        repositoryFiles: [],
      }),
    ).toThrow(/case-colliding workspace paths/);
  });

  test("rejects target identities shared across nested workspaces", () => {
    const root = makeRoot();
    const first = addWorkspace(root, "plugins/alpha/plugin-view", {
      config: "vite.config.views.ts",
      buildScript: "vite build --config vite.config.views.ts",
    });
    const second = addWorkspace(root, "packages/beta/plugin-view", {
      config: "vite.config.views.ts",
      buildScript: "vite build --config vite.config.views.ts",
    });
    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        repositoryFiles: [
          `${first.dir}/vite.config.views.ts`,
          `${second.dir}/vite.config.views.ts`,
        ],
        workspacePackages: [first, second],
      }),
    ).toThrow('target identity "plugin-view" is shared');
  });

  test("requires the config and package script to agree exactly", () => {
    const root = makeRoot();
    const withoutScript = addWorkspace(root, "plugins/no-script", {
      config: "vite.config.views.ts",
    });
    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [withoutScript],
        repositoryFiles: ["plugins/no-script/vite.config.views.ts"],
      }),
    ).toThrow(/has no non-empty build:views/);

    const wrongScript = addWorkspace(root, "plugins/wrong-script", {
      config: "vite.config.views.ts",
      buildScript: "vite build --config other.config.ts",
    });
    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [wrongScript],
        repositoryFiles: ["plugins/wrong-script/vite.config.views.ts"],
      }),
    ).toThrow(/must reference exactly vite\.config\.views\.ts/);

    const scriptOnly = addWorkspace(root, "plugins/script-only", {
      buildScript: "vite build --config vite.config.views.ts",
    });
    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [scriptOnly],
        repositoryFiles: [],
      }),
    ).toThrow(/declares build:views without/);

    const oldVite = addWorkspace(root, "plugins/old-vite", {
      config: "vite.config.views.ts",
      buildScript: "vite build --config vite.config.views.ts",
    });
    oldVite.packageJson.devDependencies.vite = "^7.0.0";
    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [oldVite],
        repositoryFiles: ["plugins/old-vite/vite.config.views.ts"],
      }),
    ).toThrow(/must declare Vite 8 or newer directly/);
  });

  test("rejects a zero-target inventory", () => {
    const root = makeRoot();
    const workspace = addWorkspace(root, "packages/no-view");
    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [workspace],
        repositoryFiles: [],
      }),
    ).toThrow(/zero configured view-build targets/);
  });

  test("filtering is exact when possible and rejects ambiguity or absence", () => {
    const targets = [
      {
        name: "plugin-feed",
        packageName: "@elizaos/plugin-feed",
        workspaceDir: "plugins/plugin-feed",
      },
      {
        name: "plugin-feed-reader",
        packageName: "@elizaos/plugin-feed-reader",
        workspaceDir: "plugins/plugin-feed-reader",
      },
    ];

    expect(selectViewBundleTargets(targets, "@ELIZAOS/PLUGIN-FEED")).toEqual([
      targets[0],
    ]);
    expect(() => selectViewBundleTargets(targets, "feed")).toThrow(/ambiguous/);
    expect(() => selectViewBundleTargets(targets, "missing")).toThrow(
      /matched no target/,
    );
  });

  test("serializes only portable targets and rejects ignored CLI input", () => {
    const root = makeRoot();
    const workspace = addWorkspace(root, "plugins/viewer", {
      config: "vite.config.views.ts",
      buildScript: "vite build --config vite.config.views.ts",
    });
    const serialized = serializeViewBundleInventory(
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [workspace],
        repositoryFiles: ["plugins/viewer/vite.config.views.ts"],
      }),
    );
    expect(serialized).toEqual({
      schemaVersion: 2,
      workspaceCount: 1,
      configCount: 1,
      discoveredCount: 1,
      excludedCount: 0,
      targets: [
        {
          name: "viewer",
          packageName: "@fixture/viewer",
          workspaceDir: "plugins/viewer",
          config: "plugins/viewer/vite.config.views.ts",
          configBytes: 11,
          configSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          bundle: "plugins/viewer/dist/views/bundle.js",
          buildScript: "vite build --config vite.config.views.ts",
          packageManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          viteDependency: "^8.0.0",
        },
      ],
      exclusions: [],
      inventorySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      parseViewInventoryArgs([
        "--json",
        "--output",
        "reports/view-inventory/out.json",
      ]),
    ).toEqual({
      help: false,
      json: true,
      output: "reports/view-inventory/out.json",
    });
    expect(() => parseViewInventoryArgs(["--jsoon"])).toThrow(
      "unknown argument",
    );
    expect(() =>
      parseViewInventoryArgs([
        "--output",
        "reports/one.json",
        "--output",
        "reports/two.json",
      ]),
    ).toThrow("only once");
    expect(() => parseViewInventoryArgs(["--help", "--json"])).toThrow(
      "cannot be combined",
    );
    expect(() =>
      parseViewInventoryArgs(["--output", "../../package.json"]),
    ).toThrow("traversal");
  });

  test("the real repository has one build contract per discovered config", () => {
    const inventory = discoverViewBundleInventory({
      repoRoot: path.resolve(import.meta.dirname, "../../.."),
    });
    expect(inventory.targets.length).toBeGreaterThan(0);
    expect(inventory.targets).toHaveLength(inventory.configCount);
    expect(inventory.exclusions).toEqual([]);
    for (const target of inventory.targets) {
      expect(target.configBytes).toBeGreaterThan(0);
      expect(target.configSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(target.packageManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(new Set(inventory.targets.map((target) => target.config)).size).toBe(
      inventory.targets.length,
    );
  });
});
