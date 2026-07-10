/**
 * Verifies the published Node entry under default package conditions after a
 * build. Clearing NODE_OPTIONS prevents source-resolution flags from hiding a
 * missing or internally broken dist artifact.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const probe = `
  const module = await import("@elizaos/plugin-elizacloud");
  if (module.default !== module.elizaOSCloudPlugin) {
    throw new Error("default and named plugin exports differ");
  }
  if (module.default?.name !== "elizaOSCloud") {
    throw new Error("built plugin export is missing or malformed");
  }
`;

export function verifyBuiltPackage({
  spawn = spawnSync,
  environment = process.env,
  executable = process.execPath,
} = {}) {
  const env = { ...environment };
  delete env.NODE_OPTIONS;
  const result = spawn(executable, ["--input-type=module", "--eval", probe], {
    cwd: packageDir,
    env,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Default-condition built-package import failed:\n${result.stderr || result.stdout}`,
    );
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  verifyBuiltPackage();
  process.stdout.write(
    "[plugin-elizacloud] default-condition dist import passed\n",
  );
}
