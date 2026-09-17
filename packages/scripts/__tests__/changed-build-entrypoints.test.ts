/**
 * Exercises package build entrypoints with isolated filesystem fixtures and
 * injected compilers, plus actual SQL build and public query composition.
 * Core packaging is verified by its packed-consumer suite.
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
import { buildPluginSql } from "../../../plugins/plugin-sql/build.ts";
import { runBuild as runEvmBuild } from "../../../plugins/plugin-wallet/src/chains/evm/build.ts";
import { buildSolanaChain } from "../../../plugins/plugin-wallet/src/chains/solana/build.ts";
import { buildCloudSdk } from "../../cloud/sdk/build.ts";
import {
  loadTemplateDefinitions,
  manifestPayloadMatches,
  readExistingManifest,
  resolveTemplateSourceDir,
  rmRecursive as rmElizaosRecursive,
  runBin,
} from "../../elizaos/build.ts";
import {
  auditBuildTypecheck,
  isFullTscEmit,
  runAuditBuildTypecheck,
} from "../audit-build-typecheck.mjs";

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

  test("plugin-sql builds public entries that compose a real parameterized query", async () => {
    await buildPluginSql();
    const child = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "-e",
        `
        import assert from "node:assert/strict";
        import plugin from "@elizaos/plugin-sql";
        import { agentTable } from "@elizaos/plugin-sql/schema";
        import { eq, sql } from "@elizaos/plugin-sql/drizzle";
        import { PgDialect } from "drizzle-orm/pg-core";
        assert.equal(typeof plugin.init, "function");
        const id = "00000000-0000-0000-0000-000000000001";
        const query = new PgDialect().sqlToQuery(sql\`select * from \${agentTable} where \${eq(agentTable.id, id)}\`);
        assert.match(query.sql, /select \\* from "agents" where "agents"\\."id" = \\$1/);
        assert.deepEqual(query.params, [id]);
      `,
      ],
      {
        cwd: path.join(repoRoot, "plugins/plugin-sql"),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  }, 60_000);

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
