/**
 * Changed-file coverage for build and typecheck entrypoints touched by the
 * TypeScript compiler-model PR. The coverage gate runs only tests changed in
 * the PR, so this suite imports each entrypoint without running a real package
 * build and exercises the orchestration branches through injected operations.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildPlugin } from "../../../plugins/plugin-build.ts";
import { buildLocalInferencePlugin } from "../../../plugins/plugin-local-inference/build.ts";
import {
  buildPluginSql,
  listDeclarationFiles,
  normalizeDeclarationSpecifiers,
  resolveDeclarationSpecifier,
} from "../../../plugins/plugin-sql/src/build.ts";
import { runBuild as runEvmBuild } from "../../../plugins/plugin-wallet/src/chains/evm/build.ts";
import { buildSolanaChain } from "../../../plugins/plugin-wallet/src/chains/solana/build.ts";
import { buildCloudSdk } from "../../cloud/sdk/build.ts";
import {
  buildAll,
  buildBrowser,
  buildEdge,
  buildNode,
  buildNodeOnly,
  buildTesting,
  cleanBuild,
  copyAssets,
  createElizaBuildConfig,
  fixDtsExtensions,
  generateDts,
  getTimer,
  runBuild,
} from "../../core/build.ts";
import {
  loadTemplateDefinitions,
  manifestPayloadMatches,
  readExistingManifest,
  resolveTemplateSourceDir,
  rmRecursive as rmElizaosRecursive,
  runBin,
} from "../../elizaos/build.ts";
import {
  feedTypecheckPlan,
  selectFeedWorkspaces,
  typecheckFeedWorkspace,
} from "../../feed/scripts/typecheck-workspace.ts";
import {
  auditBuildTypecheck,
  isFullTscEmit,
  runAuditBuildTypecheck,
} from "../audit-build-typecheck.mjs";
import { prepareDistPathDeclarations } from "../prepare-dist-path-declarations.mjs";

const repoRoot = path.resolve(import.meta.dir, "../../..");

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("changed build entrypoints", () => {
  test("cloud sdk build keeps clean, mkdir, declaration emit order injectable", async () => {
    const calls: string[] = [];
    await buildCloudSdk({
      exists: (target) => {
        calls.push(`exists:${target}`);
        return true;
      },
      removeDist: async () => calls.push("remove"),
      mkdir: async (target) => {
        calls.push(`mkdir:${target}`);
        return undefined;
      },
      emitDeclarations: async () => calls.push("emit"),
    });
    expect(calls).toEqual(["exists:dist", "remove", "mkdir:dist", "emit"]);
  });

  test("core build helpers resolve config and target orchestration without building", async () => {
    expect(getTimer().elapsedMs()).toBeGreaterThanOrEqual(0);
    const config = await createElizaBuildConfig({
      entrypoints: ["src/index.ts", "./src/extra.ts"],
      outdir: "out",
      target: "node",
      format: "esm",
      external: ["left-pad", "", "//comment"],
      selfPackageName: "@elizaos/core",
    });
    expect(config.entrypoints).toEqual(["./src/index.ts", "./src/extra.ts"]);
    expect(config.external).toContain("node:*");
    expect(config.external).toContain("left-pad");
    expect(config.external).not.toContain("@elizaos/core");

    const seen: string[] = [];
    const runnerFactory = (options: { buildOptions: { outdir?: string } }) => {
      seen.push(options.buildOptions.outdir ?? "");
      return async () => undefined;
    };
    await buildNode(runnerFactory as never);
    await buildBrowser(runnerFactory as never);
    await buildEdge(runnerFactory as never);
    await buildTesting(runnerFactory as never);
    await buildNodeOnly({
      argv: ["bun", "build.ts", "--skip-testing"],
      runnerFactory: runnerFactory as never,
      generateDeclarations: async () => seen.push("dts"),
    });
    await buildAll({
      runnerFactory: runnerFactory as never,
      generateDeclarations: async () => seen.push("dts-all"),
    });
    expect(seen).toContain("dist/node");
    expect(seen).toContain("dist/browser");
    expect(seen).toContain("dist/edge");
    expect(seen).toContain("dist/testing");
    expect(seen).toContain("dts");
    expect(seen).toContain("dts-all");
  });

  test("core declaration specifier rewrite handles files and directory barrels", async () => {
    const root = tempDir("core-dts-");
    try {
      mkdirSync(path.join(root, "nested", "dir"), { recursive: true });
      writeFileSync(path.join(root, "foo.d.ts"), "export const x: number;\n");
      writeFileSync(
        path.join(root, "nested", "dir", "index.d.ts"),
        "export {};\n",
      );
      writeFileSync(
        path.join(root, "nested", "entry.d.ts"),
        'export * from "../foo";\nimport("./dir");\nexport * from "./missing";\n',
      );
      await fixDtsExtensions(root);
      expect(
        readFileSync(path.join(root, "nested", "entry.d.ts"), "utf8"),
      ).toBe(
        'export * from "../foo.js";\nimport("./dir/index.js");\nexport * from "./missing.js";\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("core runner, asset copy, and clean helpers cover success and absent paths", async () => {
    const root = tempDir("core-runner-");
    const previous = process.cwd();
    try {
      process.chdir(root);
      mkdirSync("src", { recursive: true });
      writeFileSync("src/index.ts", "export const value = 1;\n");
      expect(
        await runBuild({
          packageName: "fixture",
          buildOptions: {
            entrypoints: ["src/index.ts"],
            outdir: "dist",
            target: "node",
            format: "esm",
            skipClean: true,
          },
        }),
      ).toBe(true);

      mkdirSync(path.join(root, "assets"), { recursive: true });
      writeFileSync(path.join(root, "assets", "a.txt"), "a");
      await copyAssets([{ from: "assets", to: "copied" }]);
      expect(readFileSync(path.join(root, "copied", "a.txt"), "utf8")).toBe(
        "a",
      );
      await expect(
        copyAssets([{ from: "missing-assets", to: "nowhere" }]),
      ).rejects.toThrow(/Failed to copy all assets/);
      mkdirSync("remove-dist", { recursive: true });
      writeFileSync(path.join("remove-dist", "old.txt"), "old");
      await cleanBuild("remove-dist");
      expect(existsSync("remove-dist")).toBe(false);
      await cleanBuild("missing-dist");
      await generateDts("missing-tsconfig.json");
    } finally {
      process.chdir(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("elizaos template manifest helpers sort and compare payloads", () => {
    const root = tempDir("elizaos-templates-");
    try {
      mkdirSync(path.join(root, "b"), { recursive: true });
      mkdirSync(path.join(root, "a"), { recursive: true });
      writeFileSync(path.join(root, "b", "template.json"), '{"name":"Beta"}\n');
      writeFileSync(
        path.join(root, "a", "template.json"),
        '{"name":"Alpha"}\n',
      );
      expect(
        loadTemplateDefinitions(root).map((template) => template.name),
      ).toEqual(["Alpha", "Beta"]);
      expect(
        manifestPayloadMatches(
          {
            version: "1",
            repoUrl: "r",
            templates: [{ name: "Alpha" }],
            generatedAt: "t",
          },
          { version: "1", repoUrl: "r", templates: [{ name: "Alpha" }] },
        ),
      ).toBe(true);
      expect(
        manifestPayloadMatches(null, {
          version: "1",
          repoUrl: "r",
          templates: [],
        }),
      ).toBe(false);
      expect(resolveTemplateSourceDir()).toContain("templates");
      expect(readExistingManifest()).not.toBeNull();
      runBin(process.execPath, ["-e", ""]);
      expect(() => runBin(process.execPath, ["-e", "process.exit(3)"])).toThrow(
        /exited with code 3/,
      );
      const removeMe = path.join(root, "remove-me");
      mkdirSync(removeMe);
      rmElizaosRecursive(removeMe);
      expect(existsSync(removeMe)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("feed typecheck planner emits required bootstrap steps before selected checks", async () => {
    expect(selectFeedWorkspaces(["bun", "script", "apps/web"])).toEqual([
      "apps/web",
    ]);
    const plan = feedTypecheckPlan(["apps/web"]);
    expect(plan).toMatchObject({
      needsAgentDeclarations: true,
      needsApiDeclarations: true,
      needsA2aDeclarations: true,
      needsCliDeclarationDependencies: true,
    });

    const calls: string[] = [];
    await typecheckFeedWorkspace(["bun", "script", "apps/web"], {
      emitDeclarations: async (workspace) => calls.push(`emit:${workspace}`),
      runTypecheck: async (workspace) => calls.push(`check:${workspace}`),
    });
    expect(calls).toEqual([
      "emit:packages/agents",
      "emit:packages/api",
      "emit:packages/a2a",
      "emit:packages/shared",
      "emit:packages/db",
      "emit:packages/core",
      "emit:packages/engine",
      "emit:packages/pack-default",
      "emit:packages/mcp",
      "check:apps/web",
    ]);
  });

  test("repo compiler audit reports violations and success exit codes", () => {
    expect(isFullTscEmit("tsc6 -p tsconfig.json")).toBe(true);
    expect(isFullTscEmit("tsc6 -p tsconfig.json --noCheck")).toBe(false);
    const violations = auditBuildTypecheck({
      rootPackage: {
        workspaces: [],
        devDependencies: {
          "@typescript/native": "npm:typescript@^7.0.2",
          "@typescript/typescript6": "6.0.0",
        },
      },
      turbo: { tasks: { typecheck: { dependsOn: ["^build"] } } },
      packageDirs: [],
      buildFiles: [],
      allow: { doubleCheck: new Set(), tscTypecheck: new Set() },
    });
    expect(
      violations.some((violation) => violation.startsWith("turbo typecheck")),
    ).toBe(true);

    const root = tempDir("audit-build-");
    try {
      const pkgDir = path.join(root, "packages", "demo");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({
          name: "@demo/pkg",
          scripts: {
            build: "bun run build.ts",
            typecheck: "tsc --noEmit",
          },
          devDependencies: { "@typescript/native": "npm:typescript@^7.0.2" },
        }),
      );
      writeFileSync(
        path.join(pkgDir, "build.ts"),
        "await $`tsc6 -p tsconfig.json`;\n",
      );
      const buildFile = path.join(root, "plugins", "demo", "build.ts");
      mkdirSync(path.dirname(buildFile), { recursive: true });
      writeFileSync(buildFile, "await Bun.build({ entrypoints: [] });\n");
      const loopViolations = auditBuildTypecheck({
        repoRoot: root,
        rootPackage: {
          workspaces: ["packages/*"],
          devDependencies: {
            "@typescript/native": "npm:typescript@^7.0.2",
            "@typescript/typescript6": "6.0.0",
          },
        },
        turbo: { tasks: {} },
        packageDirs: [pkgDir],
        buildFiles: [path.join(pkgDir, "build.ts"), buildFile],
        allow: { doubleCheck: new Set(), tscTypecheck: new Set() },
      });
      expect(loopViolations.join("\n")).toContain(
        "runs a full tsc6 type-check",
      );
      expect(loopViolations.join("\n")).toContain(
        "custom Bun build should use",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(
      runAuditBuildTypecheck({
        rootPackage: {
          workspaces: [],
          devDependencies: {
            "@typescript/native": "npm:typescript@^7.0.2",
            "@typescript/typescript6": "6.0.0",
          },
        },
        turbo: { tasks: {} },
        packageDirs: [],
        buildFiles: [],
        allow: { doubleCheck: new Set(), tscTypecheck: new Set() },
      }),
    ).toBe(0);
  });

  test("prepare dist declaration runner returns subprocess status", () => {
    const emit = { label: "fixture", cwd: process.cwd(), args: ["--version"] };
    expect(
      prepareDistPathDeclarations({
        tsc: "tsc6",
        emits: [emit],
        spawnSync: () => ({ status: 0 }),
      }),
    ).toBe(0);
    expect(
      prepareDistPathDeclarations({
        tsc: "tsc6",
        emits: [emit],
        spawnSync: () => ({ status: 2 }),
      }),
    ).toBe(2);
    expect(
      prepareDistPathDeclarations({
        tsc: "tsc6",
        emits: [emit],
        spawnSync: () => ({ status: null, error: new Error("missing") }),
      }),
    ).toBe(1);
  });

  test("plugin build driver import stays runnable on the no-target path", async () => {
    const root = tempDir("plugin-build-entry-");
    const previous = process.cwd();
    try {
      writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(
        path.join(root, "src", "index.ts"),
        "export const add = () => 1;\n",
      );
      process.chdir(root);
      await buildPlugin({ name: "fixture", clean: false, targets: [] });
      expect(existsSync(path.join(root, "dist"))).toBe(true);
      await buildPlugin({
        name: "fixture",
        targets: [
          {
            label: "Node",
            entry: "src/index.ts",
            outSubdir: "node",
            target: "node",
            format: "esm",
            renames: [["index.js", "index.node.js"]],
          },
        ],
        flatten: [{ from: "node", to: "." }],
        dtsShims: [{ path: "shim.d.ts", content: "export {};\n" }],
      });
      expect(existsSync(path.join(root, "dist", "index.node.js"))).toBe(true);
      expect(readFileSync(path.join(root, "dist", "shim.d.ts"), "utf8")).toBe(
        "export {};\n",
      );
    } finally {
      process.chdir(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("local inference build reports Bun build failure and smoke-import success", async () => {
    expect(
      await buildLocalInferencePlugin({
        rm: () => undefined,
        externals: async () => ["node:*"],
        build: async () =>
          ({ success: false, logs: ["bad"], outputs: [] }) as never,
        emitDeclarations: async () => undefined,
        smokeImport: async () => undefined,
      }),
    ).toBe(1);
    expect(
      await buildLocalInferencePlugin({
        rm: () => undefined,
        externals: async () => ["node:*"],
        build: async () => ({ success: true, logs: [], outputs: [] }) as never,
        emitDeclarations: async () => undefined,
        smokeImport: async () => undefined,
      }),
    ).toBe(0);
  });

  test("plugin-sql declaration helpers rewrite relative specifiers", async () => {
    const root = tempDir("plugin-sql-dts-");
    try {
      mkdirSync(path.join(root, "schema"), { recursive: true });
      writeFileSync(path.join(root, "types.d.ts"), "export {};\n");
      writeFileSync(path.join(root, "schema", "index.d.ts"), "export {};\n");
      writeFileSync(
        path.join(root, "index.d.ts"),
        'export * from "./types";\nexport * from "./schema";\nimport("./external");\n',
      );
      expect(resolveDeclarationSpecifier(root, "./types")).toBe("./types.js");
      expect(resolveDeclarationSpecifier(root, "./schema")).toBe(
        "./schema/index.js",
      );
      expect(listDeclarationFiles(root).sort()).toEqual([
        path.join(root, "index.d.ts"),
        path.join(root, "schema", "index.d.ts"),
        path.join(root, "types.d.ts"),
      ]);
      await normalizeDeclarationSpecifiers(path.join(root, "index.d.ts"));
      expect(readFileSync(path.join(root, "index.d.ts"), "utf8")).toContain(
        'from "./schema/index.js"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("plugin-sql build writes public shims with injected compilers", async () => {
    const dist = path.join(repoRoot, "plugins/plugin-sql/src/dist");
    rmSync(dist, { recursive: true, force: true });
    try {
      await buildPluginSql({
        build: async () =>
          ({ success: true, logs: [], outputs: [{ size: 1 }] }) as never,
        remove: () => undefined,
        emitDeclarations: async () => undefined,
        normalizeDeclarations: async () => undefined,
      });
      expect(
        readFileSync(path.join(dist, "drizzle", "index.js"), "utf8"),
      ).toContain("drizzle-orm");
      expect(
        readFileSync(path.join(dist, "schema", "index.js"), "utf8"),
      ).toContain("../node/index.node.js");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  test("wallet chain builds expose success and failure paths without real builds", async () => {
    expect(
      await runEvmBuild({
        exists: () => false,
        build: async () =>
          ({ success: false, logs: ["bad"], outputs: [] }) as never,
        emitDeclarations: async () => ({
          exitCode: 0,
          stderr: new Uint8Array(),
        }),
      }),
    ).toBe(false);
    expect(
      await runEvmBuild({
        exists: (target) => !target.endsWith("index.d.ts"),
        remove: async () => undefined,
        build: async () =>
          ({ success: true, logs: [], outputs: [{ size: 1 }] }) as never,
        emitDeclarations: async () => ({
          exitCode: 1,
          stderr: new TextEncoder().encode("warn"),
        }),
      }),
    ).toBe(true);

    expect(
      await buildSolanaChain({
        exists: () => true,
        remove: () => undefined,
        packageJson: async () => ({
          dependencies: { viem: "1" },
          peerDependencies: { react: "1" },
          devDependencies: { typescript: "1" },
        }),
        build: async () =>
          ({ success: false, logs: ["bad"], outputs: [] }) as never,
        spawn: (() => ({ exited: Promise.resolve(), exitCode: 0 })) as never,
      }),
    ).toBe(1);
    expect(
      await buildSolanaChain({
        exists: () => false,
        packageJson: async () => ({ dependencies: { viem: "1" } }),
        build: async (config) => {
          expect(config.external).toEqual(["viem"]);
          return { success: true, logs: [], outputs: [{ size: 1 }] } as never;
        },
        spawn: (() => ({ exited: Promise.resolve(), exitCode: 1 })) as never,
      }),
    ).toBe(0);
  });
});
