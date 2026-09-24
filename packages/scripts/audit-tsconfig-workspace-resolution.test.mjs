/**
 * Exercises typecheck-project discovery and workspace resolution against
 * deterministic temporary graphs, including missing builds and shadowed exports.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditTsconfigWorkspaceResolution,
  builtBeforeTypecheck,
  discoverTypecheckProjects,
  workspaceSourceEntry,
} from "./audit-tsconfig-workspace-resolution.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

test("substitutes every wildcard in a source export target", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-export-stars-"));
  try {
    const target = path.join(root, "src", "feature", "feature.ts");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "export {};\n");
    assert.equal(
      workspaceSourceEntry(
        { exports: { "./*": "./src/*/*.ts" } },
        "@scope/example/feature",
        "@scope/example",
        root,
      ),
      target,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("discovers implicit, explicit, compact, and multiple typecheck projects", () => {
  const packageDir = path.join(repoRoot, "packages", "example");
  assert.deepEqual(discoverTypecheckProjects(packageDir, "tsc --noEmit"), [
    path.join(packageDir, "tsconfig.json"),
  ]);
  assert.deepEqual(
    discoverTypecheckProjects(
      packageDir,
      "node prepare.mjs && tsc --noEmit -p tsconfig.typecheck.json && tsc -p./src/tsconfig.json --noEmit",
    ),
    [
      path.join(packageDir, "tsconfig.typecheck.json"),
      path.join(packageDir, "src", "tsconfig.json"),
    ],
  );
  assert.deepEqual(
    discoverTypecheckProjects(
      packageDir,
      "tsgo --noEmit -p tsconfig.check.json",
    ),
    [path.join(packageDir, "tsconfig.check.json")],
  );
  assert.throws(
    () => discoverTypecheckProjects(packageDir, "tsc --noEmit --project"),
    /without a project/,
  );
});

test("discovers consolidated package projects through script delegation and rejects cycles", () => {
  const packageDir = path.join(repoRoot, "packages", "example");
  const scripts = {
    typecheck: "bun run typecheck:host && bun run typecheck:renderer",
    "typecheck:host": "tsc --noEmit -p tsconfig.host.json",
    "typecheck:renderer": "bun run typecheck:ui",
    "typecheck:ui": "tsc --noEmit -p tsconfig.ui.json",
  };
  assert.deepEqual(
    discoverTypecheckProjects(packageDir, scripts.typecheck, scripts),
    [
      path.join(packageDir, "tsconfig.host.json"),
      path.join(packageDir, "tsconfig.ui.json"),
    ],
  );
  assert.throws(
    () =>
      discoverTypecheckProjects(packageDir, "bun run recursive", {
        recursive: "bun run recursive",
      }),
    /Cyclic typecheck script/,
  );
});

test("models explicit and dependency-graph Turbo builds before typecheck", () => {
  const manifests = new Map([
    ["@elizaos/owner", { dependencies: { "@elizaos/direct": "workspace:*" } }],
    [
      "@elizaos/direct",
      { dependencies: { "@elizaos/transitive": "workspace:*" } },
    ],
    ["@elizaos/transitive", {}],
    ["@elizaos/explicit", {}],
    ["@elizaos/host", {}],
  ]);
  const turbo = {
    tasks: {
      typecheck: { dependsOn: [] },
      build: { dependsOn: ["^build"] },
      "@elizaos/host#build:dist": { dependsOn: ["@elizaos/explicit#build"] },
      "@elizaos/owner#typecheck": {
        dependsOn: ["^build", "@elizaos/host#build:dist"],
      },
    },
  };
  assert.deepEqual(
    [...builtBeforeTypecheck("@elizaos/owner", manifests, turbo)].sort(),
    [
      "@elizaos/direct",
      "@elizaos/explicit",
      "@elizaos/host",
      "@elizaos/transitive",
    ],
  );
});

test("generated workspace declarations are valid only when Turbo builds them", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tsconfig-resolution-audit-"));
  try {
    writeJson(path.join(root, "package.json"), {
      workspaces: ["packages/*"],
    });
    writeJson(path.join(root, "turbo.json"), {
      tasks: { build: { dependsOn: ["^build"] }, typecheck: { dependsOn: [] } },
    });
    writeJson(path.join(root, "tsconfig.json"), {
      compilerOptions: {
        paths: { "@elizaos/target": ["./packages/target/src/index.ts"] },
      },
    });
    writeJson(path.join(root, "packages/owner/package.json"), {
      name: "@elizaos/owner",
      dependencies: { "@elizaos/bridge": "workspace:*" },
      scripts: { typecheck: "tsc --noEmit" },
    });
    writeJson(path.join(root, "packages/owner/tsconfig.json"), {
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        paths: { "@elizaos/owner/*": ["src/*"] },
      },
      include: ["src/**/*.ts"],
    });
    mkdirSync(path.join(root, "packages/owner/src"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/owner/src/index.ts"),
      'import type { Target } from "@elizaos/target";\nexport type Owner = Target;\n',
    );
    writeJson(path.join(root, "packages/target/package.json"), {
      name: "@elizaos/target",
      types: "./dist/index.d.ts",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
      scripts: { build: "tsc6 --noCheck" },
    });
    mkdirSync(path.join(root, "packages/target/dist"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/target/dist/index.d.ts"),
      "export interface Target { value: string }\n",
    );
    mkdirSync(path.join(root, "packages/target/src"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/target/src/index.ts"),
      "export interface Target { value: string }\n",
    );
    mkdirSync(path.join(root, "node_modules/@elizaos"), { recursive: true });
    symlinkSync(
      path.join(root, "packages/target"),
      path.join(root, "node_modules/@elizaos/target"),
      "dir",
    );

    const staleOutput = auditTsconfigWorkspaceResolution({ repoRoot: root });
    assert.match(
      staleOutput.violations.join("\n"),
      /unresolved @elizaos\/target/,
    );

    const turbo = JSON.parse(
      readFileSync(path.join(root, "turbo.json"), "utf8"),
    );
    turbo.tasks["@elizaos/owner#typecheck"] = {
      dependsOn: ["@elizaos/target#build"],
    };
    const builtOutput = auditTsconfigWorkspaceResolution({
      repoRoot: root,
      turbo,
    });
    assert.deepEqual(builtOutput.violations, []);

    const ownerConfig = path.join(root, "packages/owner/tsconfig.json");
    const mappedConfig = JSON.parse(readFileSync(ownerConfig, "utf8"));
    mappedConfig.compilerOptions.paths = {
      "@elizaos/target": ["../target/src/index.ts"],
    };
    const sourceMapped = auditTsconfigWorkspaceResolution({
      repoRoot: root,
      configOverrides: new Map([
        [ownerConfig, `${JSON.stringify(mappedConfig, null, 2)}\n`],
      ]),
    });
    assert.deepEqual(sourceMapped.violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an ambient workspace shim that shadows a source mapping", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tsconfig-resolution-audit-"));
  try {
    writeJson(path.join(root, "package.json"), {
      workspaces: ["packages/*"],
    });
    writeJson(path.join(root, "turbo.json"), {
      tasks: { typecheck: { dependsOn: [] } },
    });
    writeJson(path.join(root, "tsconfig.json"), {
      compilerOptions: {
        paths: { "@elizaos/target": ["./packages/target/src/index.ts"] },
      },
    });
    writeJson(path.join(root, "packages/owner/package.json"), {
      name: "@elizaos/owner",
      dependencies: { "@elizaos/target": "workspace:*" },
      scripts: { typecheck: "tsc --noEmit" },
    });
    writeJson(path.join(root, "packages/owner/tsconfig.json"), {
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        paths: {
          "@elizaos/bridge": ["../bridge/src/index.ts"],
          "@elizaos/target": ["../target/src/index.ts"],
        },
      },
      include: ["src/**/*.ts", "types/**/*.d.ts"],
    });
    mkdirSync(path.join(root, "packages/owner/src"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/owner/src/index.ts"),
      'import type { Bridge } from "@elizaos/bridge";\nexport type Owner = Bridge;\n',
    );
    mkdirSync(path.join(root, "packages/owner/types"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/owner/types/workspace-shim.d.ts"),
      'declare module "@elizaos/target" { export interface Legacy {} }\n',
    );
    writeJson(path.join(root, "packages/bridge/package.json"), {
      name: "@elizaos/bridge",
      dependencies: { "@elizaos/target": "workspace:*" },
      exports: { ".": { types: "./src/index.ts" } },
    });
    mkdirSync(path.join(root, "packages/bridge/src"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/bridge/src/index.ts"),
      'import type { Current } from "@elizaos/target";\nexport type Bridge = Current;\n',
    );
    writeJson(path.join(root, "packages/target/package.json"), {
      name: "@elizaos/target",
      exports: { ".": { types: "./src/index.ts" } },
    });
    mkdirSync(path.join(root, "packages/target/src"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/target/src/index.ts"),
      "export interface Current { value: string }\n",
    );

    const result = auditTsconfigWorkspaceResolution({ repoRoot: root });
    assert.match(
      result.violations.join("\n"),
      /ambient @elizaos\/target .* hides source exports required by/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
