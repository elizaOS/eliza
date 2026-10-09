/** Creates a committed copy of the actual runtime source graph for destructive provenance tests. */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectGepaWorkspaceSources } from "../gepa-source-proof.ts";

const source = fileURLToPath(new URL("../../../../../..", import.meta.url));
const destination = resolve(process.argv[2]);
const files = execFileSync(
  "git",
  [
    "-C",
    source,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\0")
  .filter((f) => f && existsSync(join(source, f)));
const worker =
  "packages/benchmarks/suites/planner-optimization/src/gepa-planner-case-worker.ts";
const processFile =
  "packages/benchmarks/suites/planner-optimization/src/gepa-planner-case-process.ts";
const producer =
  "packages/benchmarks/suites/planner-optimization/src/gepa-producer.ts";
const graph = await inspectGepaWorkspaceSources(
  source,
  [join(source, worker), join(source, processFile), join(source, producer)],
  new Set(files),
  [
    {
      importer: join(source, "packages/testing/src/pglite-runtime.ts"),
      specifier: "@elizaos/plugin-sql",
    },
  ],
);
const manifests = files.filter((f) => f.endsWith("package.json"));
const copied = new Set([
  "packages/benchmarks/suites/planner-optimization/gepa/engine.py",
  "packages/benchmarks/suites/planner-optimization/gepa/producer.test.ts",
  ...graph.entries.map((e) => relative(source, e.path)),
  ...manifests,
  ...files.filter((f) => /(^|\/)tsconfig[^/]*\.json$/.test(f)),
]);
for (const file of copied) {
  const target = join(destination, file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(source, file), target);
}
const workspaces = new Map<string, string>();
for (const file of manifests) {
  const manifest = JSON.parse(readFileSync(join(source, file), "utf8"));
  if (typeof manifest.name === "string")
    workspaces.set(manifest.name, dirname(file));
}
// Dependencies retain their installed third-party bytes. Workspace packages always resolve into this snapshot.
function linkDependencies(from: string, to: string) {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      mkdirSync(join(to, entry.name), { recursive: true });
      for (const name of readdirSync(join(from, entry.name))) {
        const specifier = `${entry.name}/${name}`;
        const workspace = workspaces.get(specifier);
        symlinkSync(
          workspace !== undefined
            ? join(destination, workspace)
            : join(from, entry.name, name),
          join(to, entry.name, name),
        );
      }
    } else {
      const workspace = workspaces.get(entry.name);
      symlinkSync(
        workspace !== undefined
          ? join(destination, workspace)
          : join(from, entry.name),
        join(to, entry.name),
      );
    }
  }
}
linkDependencies(
  join(source, "node_modules"),
  join(destination, "node_modules"),
);
for (const directory of new Set([...copied].map(dirname))) {
  if (!existsSync(join(source, directory, "package.json")) || directory === ".")
    continue;
  linkDependencies(
    join(source, directory, "node_modules"),
    join(destination, directory, "node_modules"),
  );
}
writeFileSync(
  join(destination, ".gitignore"),
  "node_modules/\ntest-results/\n",
);
const git = (...args: string[]) =>
  execFileSync("git", ["-C", destination, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
git("init", "--quiet");
git("add", ".");
git(
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "--quiet",
  "-m",
  "Current runtime source fixture",
);
process.stdout.write(
  JSON.stringify({
    checkout: destination,
    revision: git("rev-parse", "HEAD").trim(),
  }),
);
