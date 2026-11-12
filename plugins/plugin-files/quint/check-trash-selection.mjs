import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const result = spawnSync(
  "node",
  [
    "--experimental-transform-types",
    "--test",
    "--test-reporter=tap",
    "--test-name-pattern=deleted Files|refresh keeps only deleted",
    "plugins/plugin-files/test/browser-agent-filter.test.mjs",
  ],
  { cwd: root, encoding: "utf8" },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const directory = testOutputPath("files-trash-selection");
mkdirSync(directory, { recursive: true });
writeFileSync(path.join(directory, "implementation.tap"), output);
if (
  result.status !== 0 ||
  !/^# pass 3$/m.test(output) ||
  !/^# fail 0$/m.test(output)
)
  throw Error("Files trash selection implementation checks failed.");
console.log("Files trash selection implementation checks passed.");
