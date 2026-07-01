/**
 * Self-test for the shared plugin build driver (`plugins/plugin-build.ts`),
 * issue #10200. 57 plugin `build.ts` files delegate to `buildPlugin`, but it had
 * no dedicated test — a regression in the clean / target / rename / flatten /
 * declaration-emit / shim / copy orchestration would only surface as a broken
 * plugin dist somewhere downstream. This drives the driver against throwaway
 * fixture packages and asserts the real emitted `dist/` tree.
 *
 * Lives in packages/scripts/__tests__ (not a workspace member), so a workflow
 * must invoke it explicitly via `bun test packages/scripts/__tests__/plugin-build.test.ts`.
 *
 * The driver resolves `tsc` to an absolute path (`TSC_BIN`, via node module
 * resolution) and runs it as `node ${TSC_BIN}`, so the declaration-emit cases run
 * without `node_modules/.bin` on PATH — exactly the bare `bun test` CI shape.
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
