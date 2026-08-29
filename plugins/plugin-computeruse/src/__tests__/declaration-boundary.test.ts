/**
 * Boundary regression test for @elizaos/plugin-computeruse declaration emit
 * (issue #29772). Proves the declaration build writes only inside the plugin's
 * canonical `dist/` by running the real `tsc --emitDeclarationOnly` with the
 * real tsconfig.build.json and asserting, via `--listEmittedFiles`, that every
 * emitted path stays under the plugin root — catching both the original escape
 * into dependency source trees (1185 escaped `.d.ts` artifacts under
 * packages/core/src and friends when `paths` still resolved dependencies to
 * source) and any future regression of the build-config wiring.
 *
 * Harness: real (executes the actual tsc declaration emit used by the build);
 * falls back to walking the effective tsconfig extends chain (string or array
 * `extends`, parsed with the TypeScript compiler's own JSONC config reader)
 * and asserting no workspace dependency resolves into a foreign `src/` tree,
 * so the suite still guards the boundary on a checkout that has not built
 * core/ui/shared yet — a fallback that fails loud on the regression instead
 * of passing vacuously.
 *
 * Effective-`paths` precedence mirrors the compiler: `compilerOptions.paths`
 * is replaced as a whole property (never merged per specifier), a child config
 * replaces everything inherited, and in an `extends` array later bases
 * override earlier ones.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfigFile, sys as tsSys } from "typescript";
import { expect, test } from "vitest";

/** Path-component-safe containment: rejects sibling roots like `dist-escaped`. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))
  );
}

interface TsConfigShape {
  compilerOptions?: { paths?: Record<string, string[]> };
  extends?: string | string[];
}

/**
 * Read one tsconfig with the compiler's own JSONC config reader, so comments,
 * trailing commas, and every other tsconfig JSONC allowance behave exactly as
 * tsc treats them. Parse failures surface as boundary errors, never raw
 * SyntaxErrors.
 */
function readTsconfig(cfgPath: string): TsConfigShape {
  const { config, error } = readConfigFile(cfgPath, tsSys.readFile);
  if (error) {
    throw new Error(
      `declaration boundary: tsconfig ${cfgPath} is not parseable ` +
        `(${error.messageText}) — the emit boundary audit cannot run against ` +
        "this config chain.",
    );
  }
  return (config ?? {}) as TsConfigShape;
}

/** Resolve one `extends` spec, tolerating the optional `.json` suffix. */
function resolveExtendsTarget(fromDir: string, spec: string): string {
  const resolved = resolve(fromDir, spec);
  if (existsSync(resolved)) return resolved;
  if (existsSync(`${resolved}.json`)) return `${resolved}.json`;
  return resolved;
}

/**
 * Walk the `extends` chain (worklist over string or array `extends`) in
 * compiler precedence order and return the effective `paths`: the whole
 * `compilerOptions.paths` object from the highest-precedence config that
 * declares one — tsc replaces the property wholesale rather than merging
 * per specifier, so an audit that merged keys could retain a "safe" mapping
 * the compiler actually discarded (or miss an unsafe one it installed).
 */
function collectEffectivePaths(start: string): Record<string, string[]> {
  // Memoized recursion over the extends graph (string or array `extends`).
  // Effective paths of a config = its own `compilerOptions.paths` when
  // declared, else inherited whole-property from its bases; in an extends
  // array a later base's EFFECTIVE mapping (own or inherited) replaces the
  // earlier base's, while a base whose chain declares no paths at all leaves
  // the earlier state intact (verified against TypeScript 6.0.3
  // parseJsonConfigFileContent, including the diamond case where a later
  // base re-inherits a shared ancestor's paths). An explicit empty `paths`
  // object counts as a declaration and clears inherited mappings. The
  // recursion stack guards against extends cycles.
  const memo = new Map<
    string,
    { declared: boolean; paths: Record<string, string[]> }
  >();
  const inProgress = new Set<string>();
  const effectiveOf = (cfgPath: string) => {
    const cached = memo.get(cfgPath);
    if (cached !== undefined) return cached;
    if (inProgress.has(cfgPath)) {
      throw new Error(
        `declaration boundary: tsconfig extends cycle detected at ${cfgPath} ` +
          "— the emit boundary audit cannot run against a cyclic config chain.",
      );
    }
    inProgress.add(cfgPath);
    try {
      const raw = readTsconfig(cfgPath);
      const parents =
        raw.extends === undefined
          ? []
          : Array.isArray(raw.extends)
            ? raw.extends
            : [raw.extends];
      // Validate the full extends graph even when this config declares its
      // own paths (own declaration wins, but TypeScript still reports
      // circularity for the chain — the audit must not silently pass an
      // invalid config graph).
      const resolvedParents = parents.map((spec) =>
        resolveExtendsTarget(dirname(cfgPath), spec),
      );
      for (const parentPath of resolvedParents) {
        effectiveOf(parentPath);
      }
      const ownPaths = raw.compilerOptions?.paths;
      if (ownPaths !== undefined) {
        const result = {
          declared: true,
          paths: ownPaths as Record<string, string[]>,
        };
        memo.set(cfgPath, result);
        return result;
      }
      let result = { declared: false, paths: {} as Record<string, string[]> };
      for (const parentPath of resolvedParents) {
        const parent = effectiveOf(parentPath);
        if (parent.declared) {
          result = parent;
        }
      }
      memo.set(cfgPath, result);
      return result;
    } finally {
      inProgress.delete(cfgPath);
    }
  };
  return effectiveOf(start).paths;
}

/** Workspace-specifier paths that resolve into a foreign `src/` tree. */
function sourceMappedWorkspaceDeps(paths: Record<string, string[]>): string[] {
  const offenders: string[] = [];
  for (const [specifier, targets] of Object.entries(paths)) {
    if (!specifier.startsWith("@elizaos/")) continue;
    for (const t of targets) {
      if (/\/src\/|\/src$/.test(t)) {
        offenders.push(`${specifier} -> ${t}`);
      }
    }
  }
  return offenders;
}

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = resolve(pluginRoot, "..", "..");
const tscBin = resolve(repoRoot, "node_modules", ".bin", "tsc6");
const depDists = [
  resolve(repoRoot, "packages/core/dist/index.d.ts"),
  resolve(repoRoot, "packages/ui/dist/index.d.ts"),
  resolve(repoRoot, "packages/shared/dist/index.d.ts"),
];

test("declaration emit stays inside plugin-computeruse output roots", {
  timeout: 240_000,
}, () => {
  const missing = depDists.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    console.warn(
      `[boundary] dependency dist declarations absent (${missing.length}); ` +
        "run dependency builds first — asserting the effective config boundary " +
        "statically instead (extends chain walk, not a literal grep).",
    );
    const offenders = sourceMappedWorkspaceDeps(
      collectEffectivePaths(resolve(pluginRoot, "tsconfig.build.json")),
    );
    expect(
      offenders,
      `dts effective paths map workspace deps to source trees (static fallback):\n` +
        offenders.join("\n"),
    ).toEqual([]);
    return;
  }

  const res = spawnSync(
    tscBin,
    [
      "--project",
      "tsconfig.build.json",
      "--emitDeclarationOnly",
      "--noCheck",
      "--listEmittedFiles",
    ],
    { cwd: pluginRoot, encoding: "utf8", timeout: 240_000 },
  );
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      `declaration emit failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`,
    );
  }

  const emitted = res.stdout
    .split("\n")
    .map((l) => l.replace(/^TSFILE:\s*/, "").trim())
    .filter((l) => l.length > 0);
  expect(emitted.length).toBeGreaterThan(0);

  const escaped = emitted.filter((f) => !isInside(pluginRoot, f));
  if (escaped.length > 0) {
    throw new Error(
      `declaration emit escaped the plugin output roots (${escaped.length} files):\n` +
        `${escaped.slice(0, 10).join("\n")}${escaped.length > 10 ? "\n…" : ""}`,
    );
  }
  // Everything emitted must live under the canonical dist root.
  const outsideDist = emitted.filter(
    (f) => !isInside(resolve(pluginRoot, "dist"), f),
  );
  expect(outsideDist).toEqual([]);
});

test("dts project resolves workspace dependencies through dist, not source", () => {
  // Walk the tsconfig extends chain from tsconfig.build.json and compute the
  // effective `paths` with compiler precedence: any mapping that resolves a
  // workspace dependency into another package's `src/` tree puts foreign
  // TypeScript sources into the declaration program, and their declarations
  // get emitted beside those sources — the original #29772 failure mode
  // (1185 escaped files). The walk handles both string and array `extends`
  // and reads each config with the compiler's own JSONC reader.
  const offenders = sourceMappedWorkspaceDeps(
    collectEffectivePaths(resolve(pluginRoot, "tsconfig.build.json")),
  );
  expect(
    offenders,
    `dts effective paths map workspace deps to source trees:\n${offenders.join("\n")}`,
  ).toEqual([]);
});

test("extends-chain walker matches compiler precedence", () => {
  // Regression guard for the walker itself (review findings on #29901),
  // verified against `tsc --showConfig` behavior on TypeScript 6.0.3:
  // - array-form `extends` must never reach path.resolve as an array;
  // - `compilerOptions.paths` replaces wholesale (never per-key merge);
  // - in an extends array, a later base overrides an earlier base;
  // - a child's own paths override everything it extends;
  // - tsconfig JSONC (comments, trailing commas) parses like tsc does.
  // Uses a unique temp dir with real config files, not mocks.
  const tmpRoot = mkdtempSync(resolve(tmpdir(), "decl-boundary-"));
  const write = (name: string, body: string) =>
    writeFileSync(resolve(tmpRoot, name), body);
  try {
    write(
      "tsconfig.base1.json",
      // Trailing comma before `}` is valid tsconfig JSONC, must parse.
      `{\n  "compilerOptions": {\n    "paths": {\n      "@elizaos/safe-first": ["../dist/first"],\n      "@elizaos/shared-key": ["../dist/first"],\n    },\n  },\n}\n`,
    );
    write(
      "tsconfig.base2.json",
      JSON.stringify({
        compilerOptions: {
          // Later base overrides the earlier base's whole paths object.
          paths: { "@elizaos/shared-key": ["../pkg/src/second"] },
        },
      }),
    );
    write(
      "tsconfig.array-parent.json",
      // Line comment in JSONC body must not break the chain walk.
      `{\n  // array extends: both bases load, later wins on conflict\n  "extends": ["./tsconfig.base1.json", "./tsconfig.base2.json"]\n}\n`,
    );
    write(
      "tsconfig.child.json",
      JSON.stringify({
        extends: "./tsconfig.array-parent.json",
        // Child's own paths replace everything inherited.
        compilerOptions: {
          paths: { "@elizaos/child-only": ["../dist/child"] },
        },
      }),
    );

    // Array-parent: later base's whole paths object replaces the earlier's.
    const arrayParentPaths = collectEffectivePaths(
      resolve(tmpRoot, "tsconfig.array-parent.json"),
    );
    expect(arrayParentPaths["@elizaos/shared-key"]).toEqual([
      "../pkg/src/second",
    ]);
    // The earlier base's unique mapping is gone (wholesale replacement).
    expect(arrayParentPaths["@elizaos/safe-first"]).toBeUndefined();
    expect(sourceMappedWorkspaceDeps(arrayParentPaths)).toEqual([
      "@elizaos/shared-key -> ../pkg/src/second",
    ]);

    // Child: its own declaration replaces the entire inherited object.
    const childPaths = collectEffectivePaths(
      resolve(tmpRoot, "tsconfig.child.json"),
    );
    expect(childPaths).toEqual({ "@elizaos/child-only": ["../dist/child"] });
    expect(sourceMappedWorkspaceDeps(childPaths)).toEqual([]);

    // Diamond (verified against TypeScript 6.0.3 parseJsonConfigFileContent):
    // shared declares unsafe paths, left overrides with safe paths, right
    // extends shared WITHOUT declaring its own; top extends [left, right].
    // The compiler resolves top to shared's paths — the later base's
    // INHERITED paths replace the earlier base's own declaration. A walker
    // that dedups the shared ancestor flatly would wrongly keep left's safe
    // paths and miss the escape.
    write(
      "tsconfig.diamond-shared.json",
      JSON.stringify({
        compilerOptions: {
          paths: { "@elizaos/diamond": ["../pkg/src/shared"] },
        },
      }),
    );
    write(
      "tsconfig.diamond-left.json",
      JSON.stringify({
        extends: "./tsconfig.diamond-shared.json",
        compilerOptions: {
          paths: { "@elizaos/diamond": ["../dist/left-safe"] },
        },
      }),
    );
    write(
      "tsconfig.diamond-right.json",
      JSON.stringify({ extends: "./tsconfig.diamond-shared.json" }),
    );
    write(
      "tsconfig.diamond-top.json",
      JSON.stringify({
        extends: [
          "./tsconfig.diamond-left.json",
          "./tsconfig.diamond-right.json",
        ],
      }),
    );
    const diamondPaths = collectEffectivePaths(
      resolve(tmpRoot, "tsconfig.diamond-top.json"),
    );
    expect(diamondPaths).toEqual({
      "@elizaos/diamond": ["../pkg/src/shared"],
    });
    expect(sourceMappedWorkspaceDeps(diamondPaths)).toEqual([
      "@elizaos/diamond -> ../pkg/src/shared",
    ]);

    // Cycle (verified against TypeScript 6.0.3): a declares its own paths AND
    // extends b, b extends a. The compiler reports circularity even though a's
    // own paths would win — the walker must fail loud on the invalid graph,
    // not silently pass on the strength of a's declaration.
    write(
      "tsconfig.cycle-a.json",
      JSON.stringify({
        extends: "./tsconfig.cycle-b.json",
        compilerOptions: { paths: { "@elizaos/cycle": ["../dist/a"] } },
      }),
    );
    write(
      "tsconfig.cycle-b.json",
      JSON.stringify({ extends: "./tsconfig.cycle-a.json" }),
    );
    expect(() =>
      collectEffectivePaths(resolve(tmpRoot, "tsconfig.cycle-a.json")),
    ).toThrow(/extends cycle detected/);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
