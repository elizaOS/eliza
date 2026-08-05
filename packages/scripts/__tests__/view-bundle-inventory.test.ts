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
  const workspace = {
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
  fs.writeFileSync(
    path.join(absoluteDir, "package.json"),
    `${JSON.stringify(workspace.packageJson)}\n`,
  );
  return workspace;
}

describe("dynamic-view build inventory", () => {
  test("discovers a nested workspace and supported config extension", () => {
    const root = makeRoot();
    const workspace = addWorkspace(root, "packages/nested/viewer", {
      config: "vite.config.views.mts",
      buildScript: "bunx --bun vite build --config vite.config.views.mts",
    });

    const inventory = discoverViewBundleInventory({
      repoRoot: root,
      workspacePackages: [workspace],
      repositoryFiles: ["packages/nested/viewer/vite.config.views.mts"],
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
    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [workspace],
        repositoryFiles: ["packages\\nested\\viewer\\vite.config.views.mts"],
      }),
    ).toThrow("backslash");
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
    ).toThrow(/case-colliding or duplicate view configs/);

    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [workspace, { ...workspace, dir: "Plugins/Viewer" }],
        repositoryFiles: [],
      }),
    ).toThrow(/case-colliding or duplicate workspace paths/);
  });

  test("rejects target identities shared across nested workspaces", () => {
    const root = makeRoot();
    const first = addWorkspace(root, "plugins/alpha/plugin-view", {
      config: "vite.config.views.ts",
      buildScript: "bunx --bun vite build --config vite.config.views.ts",
    });
    const second = addWorkspace(root, "packages/beta/plugin-view", {
      config: "vite.config.views.ts",
      buildScript: "bunx --bun vite build --config vite.config.views.ts",
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
    ).toThrow(/build:views must be exactly/);

    const wrongScript = addWorkspace(root, "plugins/wrong-script", {
      config: "vite.config.views.ts",
      buildScript: "bunx --bun vite build --config other.config.ts",
    });
    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [wrongScript],
        repositoryFiles: ["plugins/wrong-script/vite.config.views.ts"],
      }),
    ).toThrow(/build:views must be exactly/);
    for (const buildScript of [
      "echo bunx --bun vite build --config vite.config.views.ts",
      "bunx --bun vite build --config vite.config.views.ts && true",
      "bunx --bun vite build --config vite.config.views.ts # producer",
    ]) {
      const deceptive = addWorkspace(
        root,
        `plugins/deceptive-${buildScript.length}`,
        {
          config: "vite.config.views.ts",
          buildScript,
        },
      );
      expect(() =>
        discoverViewBundleInventory({
          repoRoot: root,
          workspacePackages: [deceptive],
          repositoryFiles: [`${deceptive.dir}/vite.config.views.ts`],
        }),
      ).toThrow(/build:views must be exactly/);
    }

    const scriptOnly = addWorkspace(root, "plugins/script-only", {
      buildScript: "bunx --bun vite build --config vite.config.views.ts",
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
      buildScript: "bunx --bun vite build --config vite.config.views.ts",
    });
    oldVite.packageJson.devDependencies.vite = "^7.0.0";
    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [oldVite],
        repositoryFiles: ["plugins/old-vite/vite.config.views.ts"],
      }),
    ).toThrow(/must declare Vite 8 or newer directly/);

    const prereleaseVite = addWorkspace(root, "plugins/prerelease-vite", {
      config: "vite.config.views.ts",
      buildScript: "bunx --bun vite build --config vite.config.views.ts",
    });
    prereleaseVite.packageJson.devDependencies.vite = "^8.0.0-beta.1";
    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [prereleaseVite],
        repositoryFiles: ["plugins/prerelease-vite/vite.config.views.ts"],
      }),
    ).toThrow(/must declare Vite 8 or newer directly/);
  });

  test("rejects symlinked workspace manifests, configs, and ancestors", () => {
    const root = makeRoot();
    const workspace = addWorkspace(root, "plugins/linked", {
      config: "vite.config.views.ts",
      buildScript: "bunx --bun vite build --config vite.config.views.ts",
    });
    const outsideManifest = path.join(root, "outside-package.json");
    fs.writeFileSync(outsideManifest, '{"name":"outside"}\n');
    fs.rmSync(path.join(root, workspace.dir, "package.json"));
    fs.symlinkSync(
      outsideManifest,
      path.join(root, workspace.dir, "package.json"),
    );
    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [workspace],
        repositoryFiles: [`${workspace.dir}/vite.config.views.ts`],
      }),
    ).toThrow("may not traverse a symlink");

    const configWorkspace = addWorkspace(root, "plugins/linked-config", {
      config: "vite.config.views.ts",
      buildScript: "bunx --bun vite build --config vite.config.views.ts",
    });
    const outsideConfig = path.join(root, "outside-config.ts");
    fs.writeFileSync(outsideConfig, "export {};\n");
    fs.rmSync(path.join(root, configWorkspace.dir, "vite.config.views.ts"));
    fs.symlinkSync(
      outsideConfig,
      path.join(root, configWorkspace.dir, "vite.config.views.ts"),
    );
    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [configWorkspace],
        repositoryFiles: [`${configWorkspace.dir}/vite.config.views.ts`],
      }),
    ).toThrow("may not traverse a symlink");

    const externalWorkspace = path.join(root, "external-workspace");
    fs.mkdirSync(externalWorkspace);
    fs.writeFileSync(
      path.join(externalWorkspace, "package.json"),
      '{"name":"@fixture/ancestor"}\n',
    );
    fs.writeFileSync(
      path.join(externalWorkspace, "vite.config.views.ts"),
      "export {};\n",
    );
    fs.symlinkSync(externalWorkspace, path.join(root, "linked-workspace"));
    expect(() =>
      discoverViewBundleInventory({
        repoRoot: root,
        workspacePackages: [
          {
            name: "@fixture/ancestor",
            dir: "linked-workspace",
            packageJson: {
              name: "@fixture/ancestor",
              devDependencies: { vite: "^8.0.0" },
              scripts: {
                "build:views":
                  "bunx --bun vite build --config vite.config.views.ts",
              },
            },
          },
        ],
        repositoryFiles: ["linked-workspace/vite.config.views.ts"],
      }),
    ).toThrow("may not traverse a symlink");
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
        name: "plugin-alpha",
        packageName: "@elizaos/plugin-alpha",
        workspaceDir: "plugins/plugin-alpha",
      },
      {
        name: "plugin-alpha-reader",
        packageName: "@elizaos/plugin-alpha-reader",
        workspaceDir: "plugins/plugin-alpha-reader",
      },
    ];

    expect(selectViewBundleTargets(targets, "@ELIZAOS/PLUGIN-ALPHA")).toEqual([
      targets[0],
    ]);
    expect(() => selectViewBundleTargets(targets, "alpha")).toThrow(
      /ambiguous/,
    );
    expect(() => selectViewBundleTargets(targets, "missing")).toThrow(
      /matched no target/,
    );
  });

  test("serializes only portable targets and rejects ignored CLI input", () => {
    const root = makeRoot();
    const workspace = addWorkspace(root, "plugins/viewer", {
      config: "vite.config.views.ts",
      buildScript: "bunx --bun vite build --config vite.config.views.ts",
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
          buildScript: "bunx --bun vite build --config vite.config.views.ts",
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
