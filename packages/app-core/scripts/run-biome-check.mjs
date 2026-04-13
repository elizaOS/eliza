import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const BIOME_CRASHER_PATHS = new Set([
  "eliza/packages/native-plugins/screencapture/src/web.ts",
  "eliza/packages/native-plugins/talkmode/electrobun/src/index.d.ts",
  "eliza/packages/native-plugins/gateway/electrobun/src/index.ts",
  "eliza/packages/app-core/src/types/elizaos-tui-fallback.d.ts",
  "eliza/packages/app-core/src/types/optional-plugin-modules.d.ts",
  "scripts/type-audit-report.json",
  "scripts/type-audit-report.md",
]);

const BIOME_ROOTS = ["src", "scripts", "apps"];
// Windows shell invocations hit command length limits quickly. Keep chunks
// smaller there so `bunx biome check` can run reliably in pre-review hooks.
const BIOME_CHUNK_SIZE = process.platform === "win32" ? 40 : 200;
const BIOME_FILE_PATTERN =
  /\.(?:[cm]?js|[cm]?ts|jsx|tsx|json|jsonc|css|md|mdx)$/i;

function getBiomeFiles() {
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...BIOME_ROOTS,
    ],
    { encoding: "utf8" },
  );

  return output
    .split("\0")
    .filter(Boolean)
    .filter((file) => !BIOME_CRASHER_PATHS.has(file))
    .filter((file) => BIOME_FILE_PATTERN.test(file))
    .filter((file) => existsSync(file));
}

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

const files = getBiomeFiles();
if (files.length === 0) {
  console.error("[biome-check] No files matched the configured roots.");
  process.exit(1);
}

const extraArgs = process.argv.slice(2);
for (const group of chunk(files, BIOME_CHUNK_SIZE)) {
  const result = spawnSync(
    "bunx",
    ["@biomejs/biome", "check", ...extraArgs, ...group],
    {
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (
    (result.status ?? 1) !== 0 &&
    combinedOutput.includes("No files were processed in the specified paths.")
  ) {
    continue;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
