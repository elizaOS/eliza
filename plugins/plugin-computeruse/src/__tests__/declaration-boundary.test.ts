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
 * falls back to a static config-boundary assertion when the dependency dist
 * declarations are absent, so the suite still runs on a checkout that has not
 * built core/ui/shared yet.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

/** Path-component-safe containment: rejects sibling roots like `dist-escaped`. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))
  );
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
        "run dependency builds first — asserting config boundary statically instead.",
    );
    const body = readFileSync(
      resolve(pluginRoot, "tsconfig.build.json"),
      "utf8",
    );
    expect(body).not.toMatch(/packages\/[a-z-]+\/src\//);
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
  // Walk the tsconfig extends chain from tsconfig.build.json and collect the
  // effective `paths`: any mapping that resolves a workspace dependency into
  // another package's `src/` tree puts foreign TypeScript sources into the
  // declaration program, and their declarations get emitted beside those
  // sources — the original #29772 failure mode (1185 escaped files).
  const seen = new Set<string>();
  let cfgPath = resolve(pluginRoot, "tsconfig.build.json");
  const collected: Record<string, string[]> = {};
  while (cfgPath && !seen.has(cfgPath)) {
    seen.add(cfgPath);
    const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
    for (const [k, v] of Object.entries(raw.compilerOptions?.paths ?? {})) {
      collected[k] ??= v as string[];
    }
    if (!raw.extends) break;
    cfgPath = resolve(dirname(cfgPath), raw.extends);
  }

  const offenders: string[] = [];
  for (const [specifier, targets] of Object.entries(collected)) {
    if (!specifier.startsWith("@elizaos/")) continue;
    for (const t of targets) {
      if (/\/src\/|\/src$/.test(t)) {
        offenders.push(`${specifier} -> ${t}`);
      }
    }
  }
  expect(
    offenders,
    `dts effective paths map workspace deps to source trees:\n${offenders.join("\n")}`,
  ).toEqual([]);
});
