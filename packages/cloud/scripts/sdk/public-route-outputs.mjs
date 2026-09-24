/** Owns the generated public-route file inventory and rejects stale or foreign outputs. */
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const PUBLIC_ROUTE_GENERATED_HEADER =
  "/** Generated public route contracts. Regenerate with scripts/generate-public-routes.mjs. */";
export const PUBLIC_ROUTE_OUTPUT_PATHS = [
  "public-routes.ts",
  "public-routes/descriptors.generated.ts",
  "public-routes/types.generated.ts",
  "public-routes/client.generated.ts",
];

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    // error-policy:J3 missing generated files are explicit inventory failures.
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function inspectPublicRouteOutputs(sourceRoot) {
  const missing = [];
  for (const relativePath of PUBLIC_ROUTE_OUTPUT_PATHS) {
    if (
      (await readOptional(path.join(sourceRoot, relativePath))) === undefined
    ) {
      missing.push(relativePath);
    }
  }
  const outputDir = path.join(sourceRoot, "public-routes");
  let entries;
  try {
    entries = await readdir(outputDir, { withFileTypes: true });
  } catch (error) {
    // error-policy:J3 absent output directories are represented by missing files.
    if (error.code !== "ENOENT") throw error;
    entries = [];
  }
  const orphaned = [];
  const foreign = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".generated.ts")) continue;
    const relativePath = `public-routes/${entry.name}`;
    const absolutePath = path.join(sourceRoot, relativePath);
    if (
      !entry.isFile() ||
      !(await readFile(absolutePath, "utf8")).startsWith(
        PUBLIC_ROUTE_GENERATED_HEADER,
      )
    ) {
      foreign.push(relativePath);
    } else if (!PUBLIC_ROUTE_OUTPUT_PATHS.includes(relativePath)) {
      orphaned.push(relativePath);
    }
  }
  // Never follow a symlink when replacing the compatibility facade.
  try {
    if (!(await lstat(path.join(sourceRoot, "public-routes.ts"))).isFile()) {
      foreign.push("public-routes.ts");
    }
  } catch (error) {
    // error-policy:J3 the missing facade is already in the missing inventory.
    if (error.code !== "ENOENT") throw error;
  }
  return { missing, orphaned: orphaned.sort(), foreign: foreign.sort() };
}

export async function reconcilePublicRouteOutputs(
  sourceRoot,
  outputs,
  { check = false } = {},
) {
  const supplied = outputs.map(({ relativePath }) => relativePath);
  if (
    new Set(supplied).size !== supplied.length ||
    supplied.length !== PUBLIC_ROUTE_OUTPUT_PATHS.length ||
    supplied.some((p) => !PUBLIC_ROUTE_OUTPUT_PATHS.includes(p))
  ) {
    throw new Error(
      "Generated public route outputs do not match the owned inventory",
    );
  }
  const inventory = await inspectPublicRouteOutputs(sourceRoot);
  if (inventory.foreign.length > 0) {
    throw new Error(
      `Refusing to replace foreign public route outputs: ${inventory.foreign.join(", ")}`,
    );
  }
  const stale = [];
  for (const { relativePath, source } of outputs) {
    if ((await readOptional(path.join(sourceRoot, relativePath))) !== source)
      stale.push(relativePath);
  }
  if (!check) {
    for (const { relativePath, source } of outputs) {
      const outputPath = path.join(sourceRoot, relativePath);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, source);
    }
    for (const relativePath of inventory.orphaned)
      await unlink(path.join(sourceRoot, relativePath));
  }
  return [...stale, ...inventory.orphaned];
}
