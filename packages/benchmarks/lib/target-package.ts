/** Resolve public APIs from the selected checkout without falling back to another revision. */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { listPackages } from "../../scripts/lib/workspaces.ts";

/** Resolve the measured checkout's public export, rejecting another checkout. */
export async function importMeasuredPackage<T = Record<string, unknown>>(
  repoRoot: string,
  specifier: string,
): Promise<T> {
  const root = realpathSync(repoRoot);
  const name = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  const owner = listPackages({ repoRoot: root }).find(
    (entry) => entry.name === name,
  );
  if (!owner) throw new Error(`No workspace package ${name} in ${root}`);
  const entry = realpathSync(
    createRequire(join(root, owner.dir, "package.json")).resolve(specifier),
  );
  const location = relative(root, entry);
  if (
    location === ".." ||
    location.startsWith(`..${sep}`) ||
    isAbsolute(location)
  ) {
    throw new Error(
      `Measured package ${specifier} resolved outside ${root}: ${entry}`,
    );
  }
  return import(pathToFileURL(entry).href) as Promise<T>;
}
