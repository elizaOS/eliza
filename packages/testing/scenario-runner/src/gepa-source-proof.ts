/** Bind fixture execution to clean, committed workspace sources. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();

/** Source ownership, not third-party dependency attestation. Resolve at each actual importer. */
export async function inspectGepaWorkspaceSources(
  checkout: string,
  entryPaths: string[],
  tracked: Set<string>,
  computedImports: Array<{ importer: string; specifier: string }> = [],
) {
  const pending = [...entryPaths];
  const entries = new Map<string, { path: string; sha256: string }>();
  const edges: Array<{ importer: string; specifier: string; path: string }> =
    [];
  const resolveImport = async (importer: string, specifier: string) => {
    const path = await realpath(Bun.resolveSync(specifier, dirname(importer)));
    const local = relative(checkout, path);
    if (local.startsWith("..") || isAbsolute(local))
      throw new Error(
        `Runtime import resolves outside the checkout: ${importer} -> ${specifier} -> ${path}`,
      );
    edges.push({ importer, specifier, path });
    pending.push(path);
  };
  for (const edge of computedImports)
    await resolveImport(edge.importer, edge.specifier);
  while (pending.length) {
    const path = await realpath(pending.pop() as string);
    if (entries.has(path)) continue;
    const local = relative(checkout, path);
    if (local.startsWith("..") || isAbsolute(local) || !tracked.has(local))
      throw new Error(
        `Runtime source is not owned and tracked by the checkout: ${path}`,
      );
    const source = await readFile(path);
    entries.set(path, {
      path,
      sha256: createHash("sha256").update(source).digest("hex"),
    });
    if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extname(path)))
      continue;
    const loader = [".tsx", ".jsx"].includes(extname(path)) ? "tsx" : "ts";
    const imports = new Bun.Transpiler({ loader }).scan(source).imports;
    for (const dependency of imports) {
      // External packages/builtins retain their normal loader behavior; this proof
      // intentionally makes no attestation claim about their installed contents.
      if (
        dependency.path.startsWith("@elizaos/") ||
        dependency.path.startsWith(".") ||
        isAbsolute(dependency.path)
      )
        await resolveImport(path, dependency.path);
    }
  }
  return {
    entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
    edges: edges.sort((a, b) =>
      `${a.importer}:${a.specifier}`.localeCompare(
        `${b.importer}:${b.specifier}`,
      ),
    ),
  };
}

export async function proveGepaSources(
  expectedRevision: string,
  additionalSourcePaths: string[] = [],
) {
  const revision = git("rev-parse", "HEAD");
  if (revision !== expectedRevision)
    throw new Error("Runtime revision changed before or during evaluation");
  if (git("status", "--porcelain", "--untracked-files=all").length)
    throw new Error(
      "GEPA evaluation requires clean committed workspace sources",
    );
  const checkout = await realpath(root);
  const tracked = new Set(git("ls-files", "-z").split("\0"));
  const sourceGraph = await inspectGepaWorkspaceSources(
    checkout,
    [
      fileURLToPath(new URL("./gepa-planner-case-worker.ts", import.meta.url)),
      ...additionalSourcePaths,
    ],
    tracked,
    // The PGlite helper constructs this specifier dynamically, so it cannot be
    // found by the literal-import scanner. Bind it at its actual call site.
    [
      {
        importer: fileURLToPath(
          new URL("../../src/pglite-runtime.ts", import.meta.url),
        ),
        specifier: "@elizaos/plugin-sql",
      },
    ],
  );
  return {
    revision,
    checkout,
    tree: git("rev-parse", "HEAD^{tree}"),
    ...sourceGraph,
  };
}

if (import.meta.main) {
  const [revision, ...additionalSources] = process.argv.slice(2);
  if (!revision) throw new Error("Source proof requires an expected revision");
  process.stdout.write(
    `${JSON.stringify(await proveGepaSources(revision, additionalSources))}\n`,
  );
}
