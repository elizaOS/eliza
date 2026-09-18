/**
 * Exercises the shared plugin build driver against disposable packages and
 * captures real workspace compiler outputs to prevent source-tree emission.
 * Declaration fixtures invoke the resolved compiler without relying on PATH.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  type BuildPluginConfig,
  buildPlugin,
} from "../../../plugins/plugin-build.ts";
import { externalsFromPackageJson } from "../../../plugins/plugin-build-externals.ts";

const TS_CONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    declaration: true,
    emitDeclarationOnly: true,
    rootDir: "src",
    outDir: "dist",
    skipLibCheck: true,
    types: [],
    strict: false,
  },
  include: ["src"],
};

describe("workspace production emit", () => {
  test.each([
    ["packages/agent", "index.js"],
    ["plugins/plugin-computeruse", "index.d.ts"],
    ["plugins/plugin-wallet", "index.d.ts"],
  ])(
    "keeps %s compiler outputs inside its distribution",
    (workspace, entry) => {
      const root = fileURLToPath(
        new URL(`../../../${workspace}/`, import.meta.url),
      );
      const config = ts.getParsedCommandLineOfConfigFile(
        path.join(root, "tsconfig.build.json"),
        { noCheck: true, incremental: false },
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic(diagnostic) {
            throw new Error(
              ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
            );
          },
        },
      );
      if (!config)
        throw new Error(`Cannot parse ${workspace} build configuration`);
      expect(config.errors).toEqual([]);
      const emitted: string[] = [];
      const program = ts.createProgram(config.fileNames, config.options);
      const result = program.emit(undefined, (file) =>
        emitted.push(path.resolve(file)),
      );
      const outputRoot = path.join(root, "dist");
      if (result.emitSkipped) {
        // Declaration-only compilation deliberately skips imported JSON assets.
        // A skipped TypeScript module would still leave a broken distribution.
        expect(
          program
            .getSourceFiles()
            .filter(
              (source) =>
                !source.isDeclarationFile &&
                !source.fileName.endsWith(".json") &&
                program.emit(source, () => {}).emitSkipped,
            )
            .map((source) => source.fileName),
        ).toEqual([]);
      }
      expect(result.diagnostics).toEqual([]);
      expect(emitted).toContain(path.join(outputRoot, entry));
      expect(
        emitted.filter((file) => !file.startsWith(`${outputRoot}${path.sep}`)),
      ).toEqual([]);
    },
    30_000,
  );
});

let originalCwd: string;
let fixtureDir: string;

/** Create a throwaway plugin package and chdir into it (buildPlugin uses cwd). */
function makeFixture(opts: {
  pkg?: Record<string, unknown>;
  src?: string;
  tsconfig?: boolean;
  /** Real dependency packages to drop into the fixture's node_modules. */
  deps?: Record<
    string,
    { packageJson?: Record<string, unknown>; index: string }
  >;
}) {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "plugin-build-"));
  writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify(
      {
        name: "@elizaos/fixture-plugin",
        version: "0.0.0",
        type: "module",
        ...opts.pkg,
      },
      null,
      2,
    ),
  );
  mkdirSync(path.join(fixtureDir, "src"), { recursive: true });
  writeFileSync(
    path.join(fixtureDir, "src", "index.ts"),
    opts.src ?? "export const add = (a: number, b: number): number => a + b;\n",
  );
  if (opts.tsconfig ?? true) {
    writeFileSync(
      path.join(fixtureDir, "tsconfig.json"),
      JSON.stringify(TS_CONFIG, null, 2),
    );
  }
  for (const [name, dep] of Object.entries(opts.deps ?? {})) {
    const depDir = path.join(fixtureDir, "node_modules", name);
    mkdirSync(depDir, { recursive: true });
    writeFileSync(
      path.join(depDir, "package.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        type: "module",
        main: "index.js",
        ...dep.packageJson,
      }),
    );
    writeFileSync(path.join(depDir, "index.js"), dep.index);
  }
  process.chdir(fixtureDir);
  return fixtureDir;
}

const distPath = (...p: string[]) => path.join(fixtureDir, "dist", ...p);

beforeEach(() => {
  originalCwd = process.cwd();
});

afterEach(() => {
  process.chdir(originalCwd);
  if (fixtureDir && existsSync(fixtureDir)) {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe("buildPlugin (shared driver, issue #10200)", () => {
  test("empty-targets + dtsProject emits declarations only (the tsc-only plugin path)", async () => {
    makeFixture({});
    await buildPlugin({
      name: "@elizaos/fixture-plugin",
      targets: [],
      dtsProject: "tsconfig.json",
    });
    expect(existsSync(distPath("index.d.ts"))).toBe(true);
    expect(readFileSync(distPath("index.d.ts"), "utf8")).toContain("add");
    // No JS bundle on the tsc-only path.
    expect(existsSync(distPath("index.js"))).toBe(false);
  });

  test("dtsEmitDeclarationOnly passes --emitDeclarationOnly (tsconfig that also emits JS)", async () => {
    // tsconfig WITHOUT emitDeclarationOnly: only --emitDeclarationOnly on the CLI
    // keeps this from emitting index.js alongside the declarations.
    makeFixture({ tsconfig: false });
    writeFileSync(
      path.join(fixtureDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            ...TS_CONFIG.compilerOptions,
            emitDeclarationOnly: false,
          },
          include: ["src"],
        },
        null,
        2,
      ),
    );
    await buildPlugin({
      name: "@elizaos/fixture-plugin",
      targets: [],
      dtsProject: "tsconfig.json",
      dtsEmitDeclarationOnly: true,
    });
    expect(existsSync(distPath("index.d.ts"))).toBe(true);
    // --emitDeclarationOnly suppressed the JS the tsconfig would otherwise emit.
    expect(existsSync(distPath("index.js"))).toBe(false);
  });

  test("clean removes stale dist contents before building", async () => {
    makeFixture({});
    mkdirSync(distPath(), { recursive: true });
    writeFileSync(distPath("STALE.txt"), "leftover");
    await buildPlugin({
      name: "@elizaos/fixture-plugin",
      clean: true,
      targets: [],
      dtsProject: "tsconfig.json",
    });
    expect(existsSync(distPath("STALE.txt"))).toBe(false);
    expect(existsSync(distPath("index.d.ts"))).toBe(true);
  });

  test("clean:false preserves pre-existing dist contents", async () => {
    makeFixture({});
    mkdirSync(distPath(), { recursive: true });
    writeFileSync(distPath("KEEP.txt"), "keep me");
    await buildPlugin({
      name: "@elizaos/fixture-plugin",
      clean: false,
      targets: [],
      dtsProject: "tsconfig.json",
    });
    expect(existsSync(distPath("KEEP.txt"))).toBe(true);
  });

  test("pruneAfterDts removes declaration-only trees recreated by tsc", async () => {
    makeFixture({});
    mkdirSync(path.join(fixtureDir, "src", "renderer"), { recursive: true });
    writeFileSync(
      path.join(fixtureDir, "src", "renderer", "view.ts"),
      "export interface ViewProps { title: string }\n",
    );
    writeFileSync(
      path.join(fixtureDir, "src", "index.ts"),
      'void import("./renderer/view");\nexport const loaded = true;\n',
    );

    await buildPlugin({
      name: "@elizaos/fixture-plugin",
      targets: [],
      dtsProject: "tsconfig.json",
      pruneAfterDts: ["renderer"],
    });

    expect(existsSync(distPath("renderer"))).toBe(false);
    expect(existsSync(distPath("index.d.ts"))).toBe(true);
    expect(readFileSync(distPath("index.d.ts"), "utf8")).not.toContain(
      "renderer",
    );
  });

  test("pruneAfterDts rejects targets outside dist", async () => {
    makeFixture({ tsconfig: false });
    await expect(
      buildPlugin({
        name: "@elizaos/fixture-plugin",
        targets: [],
        pruneAfterDts: ["../src"],
      }),
    ).rejects.toThrow("Refusing to prune path outside dist");
    expect(existsSync(path.join(fixtureDir, "src", "index.ts"))).toBe(true);
  });

  test("full path: target build + renames + flatten + shims + copies", async () => {
    makeFixture({});
    const config: BuildPluginConfig = {
      name: "@elizaos/fixture-plugin",
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
      dtsProject: "tsconfig.json",
      dtsShims: [{ path: "shim.d.ts", content: "export {};\n" }],
      dtsCopies: [{ from: "index.d.ts", to: "index.d.mts" }],
    };
    await buildPlugin(config);

    // Bun.build emitted, then renamed.
    expect(existsSync(distPath("node", "index.node.js"))).toBe(false); // flattened away
    expect(existsSync(distPath("index.node.js"))).toBe(true);
    expect(existsSync(distPath("node"))).toBe(false); // empty subdir removed
    expect(readFileSync(distPath("index.node.js"), "utf8")).toContain("add");

    // Declarations + shim + copy.
    expect(existsSync(distPath("index.d.ts"))).toBe(true);
    expect(readFileSync(distPath("shim.d.ts"), "utf8")).toBe("export {};\n");
    expect(existsSync(distPath("index.d.mts"))).toBe(true);
    expect(readFileSync(distPath("index.d.mts"), "utf8")).toBe(
      readFileSync(distPath("index.d.ts"), "utf8"),
    );
  });

  test("renames + flatten work with no tsc (pure-fs orchestration, no dtsProject)", async () => {
    // Decoupled from the compiler so a moveTreeContents/rename regression is
    // caught even where tsc is unavailable.
    makeFixture({ tsconfig: false });
    await buildPlugin({
      name: "@elizaos/fixture-plugin",
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
    });
    expect(existsSync(distPath("index.node.js"))).toBe(true);
    expect(existsSync(distPath("node"))).toBe(false);
    expect(readFileSync(distPath("index.node.js"), "utf8")).toContain("add");
  });

  test("externals:auto externalizes a declared dep; externals:[] inlines it", async () => {
    // The marker body proves externalization: an externalized dep keeps only the
    // bare import (no marker bytes), an inlined dep carries the marker into the
    // bundle. Asserting the import *specifier* alone would be tautological.
    const MARKER = "INLINED_MARKER_9f3a2b";
    const depIndex = `export const m = "${MARKER}";\nexport default m;\n`;
    const fixtureOpts = {
      pkg: { dependencies: { "fixture-marker-dep": "1.0.0" } },
      src: 'import m from "fixture-marker-dep";\nexport const v = m;\n',
      deps: { "fixture-marker-dep": { index: depIndex } },
    };
    const target = {
      label: "Node",
      entry: "src/index.ts",
      outSubdir: ".",
      target: "node" as const,
      format: "esm" as const,
    };

    makeFixture(fixtureOpts);
    await buildPlugin({
      name: "@elizaos/fixture-plugin",
      externals: "auto",
      targets: [target],
    });
    const autoBundle = readFileSync(distPath("index.js"), "utf8");
    expect(autoBundle).toContain("fixture-marker-dep"); // bare import survives
    expect(autoBundle).not.toContain(MARKER); // body NOT inlined → externalized
    process.chdir(originalCwd);
    rmSync(fixtureDir, { recursive: true, force: true });

    makeFixture(fixtureOpts);
    await buildPlugin({
      name: "@elizaos/fixture-plugin",
      externals: [],
      targets: [target],
    });
    const inlinedBundle = readFileSync(distPath("index.js"), "utf8");
    expect(inlinedBundle).toContain(MARKER); // body inlined → NOT externalized
  });

  test("a failing Bun.build aborts with a thrown error (no silent success)", async () => {
    makeFixture({ src: "export const ok = 1;\n" });
    await expect(
      buildPlugin({
        name: "@elizaos/fixture-plugin",
        targets: [
          {
            label: "Node",
            entry: "src/does-not-exist.ts",
            outSubdir: "node",
            target: "node",
            format: "esm",
          },
        ],
      }),
    ).rejects.toThrow();
  });

  test("dtsTolerant swallows a failed declaration emit and warns, keeping JS outputs", async () => {
    // No tsconfig present → tsc fails (TS5058, missing project) → tolerant mode
    // must warn + continue rather than abort. Spy on console.warn to prove the
    // tolerant branch actually fired (not that tsc silently never ran).
    makeFixture({ tsconfig: false });
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await buildPlugin({
        name: "@elizaos/fixture-plugin",
        targets: [
          {
            label: "Node",
            entry: "src/index.ts",
            outSubdir: ".",
            target: "node",
            format: "esm",
          },
        ],
        dtsProject: "tsconfig.json",
        dtsTolerant: true,
      });
    } finally {
      console.warn = realWarn;
    }
    // JS target survived even though declaration emit failed.
    expect(existsSync(distPath("index.js"))).toBe(true);
    expect(existsSync(distPath("index.d.ts"))).toBe(false);
    // The tolerant branch logged the specific warning.
    expect(warnings.some((w) => /declaration generation failed/i.test(w))).toBe(
      true,
    );
  });

  test("dtsProject failure WITHOUT dtsTolerant rejects (the strict default)", async () => {
    makeFixture({ tsconfig: false });
    await expect(
      buildPlugin({
        name: "@elizaos/fixture-plugin",
        targets: [],
        dtsProject: "tsconfig.json",
      }),
    ).rejects.toThrow();
  });
});

describe("externalsFromPackageJson (shared driver helper)", () => {
  test("merges deps + peer + optional + extra, sorted and de-duped", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plugin-build-ext-"));
    try {
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          dependencies: { zod: "1", axios: "1" },
          peerDependencies: { react: "1" },
          optionalDependencies: { sharp: "1" },
        }),
      );
      const externals = await externalsFromPackageJson(
        path.join(dir, "package.json"),
        { extra: ["node:fs", "axios"] },
      );
      expect(externals).toEqual(["axios", "node:fs", "react", "sharp", "zod"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("includePeer:false / includeOptional:false drop those buckets", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plugin-build-ext-"));
    try {
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          dependencies: { zod: "1" },
          peerDependencies: { react: "1" },
          optionalDependencies: { sharp: "1" },
        }),
      );
      const externals = await externalsFromPackageJson(
        path.join(dir, "package.json"),
        { includePeer: false, includeOptional: false },
      );
      expect(externals).toEqual(["zod"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
