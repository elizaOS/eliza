/**
 * Removes optional hydrated assets only after proving built output does not reference them.
 *
 * Vite copies all of public/, including artifact-bundle directories that may
 * exist only in developer checkouts. A reference aborts the entire prune before
 * any deletion so deployment output can never contain a pruning-induced 404.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const PRUNED_PATHS = ["brand/background", "product"];

const SEARCHABLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".svg",
  ".txt",
  ".webmanifest",
  ".xml",
]);

function listSearchableFiles(root, excludedRoots) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      if (
        excludedRoots.some(
          (excluded) =>
            absolutePath === excluded ||
            absolutePath.startsWith(`${excluded}${sep}`),
        )
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (
        entry.isFile() &&
        SEARCHABLE_EXTENSIONS.has(extname(entry.name))
      ) {
        files.push(absolutePath);
      }
    }
  };
  visit(root);
  return files;
}

export function pruneUnusedStaticAssets(distRoot) {
  const absoluteRoot = resolve(distRoot);
  if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
    throw new Error(`Homepage dist directory does not exist: ${absoluteRoot}`);
  }

  const candidates = PRUNED_PATHS.map((path) => ({
    path,
    absolutePath: resolve(absoluteRoot, path),
  }));
  const files = listSearchableFiles(
    absoluteRoot,
    candidates.map((candidate) => candidate.absolutePath),
  );
  const references = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const candidate of candidates) {
      if (
        source.includes(`/${candidate.path}/`) ||
        source.includes(`${candidate.path}/`)
      ) {
        references.push(
          `${relative(absoluteRoot, file)} -> ${candidate.path}/`,
        );
      }
    }
  }

  if (references.length > 0) {
    throw new Error(
      `Refusing to prune referenced homepage assets:\n${references.join("\n")}`,
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate.absolutePath)) {
      rmSync(candidate.absolutePath, { recursive: true });
    }
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  pruneUnusedStaticAssets(resolve(import.meta.dirname, "../dist"));
}
