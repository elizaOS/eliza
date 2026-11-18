/** Require the real image handler and SDK HTTP funding regression. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
if (process.argv[2])
  assert.equal(
    path.resolve(process.argv[2]),
    path.join(import.meta.dirname, "NativeImageOperation.qnt")
  );
const base = testOutputPath("quint-native-image-operation");
mkdirSync(base, { recursive: true });
const output = mkdtempSync(path.join(base, "run-"));
const report = path.join(output, "vitest.json");
const file = "__tests__/image-native-funding.http.test.ts";
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-vitest.ts"),
    "run",
    "--config",
    "vitest.config.ts",
    "--no-file-parallelism",
    file,
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: path.join(root, "plugins/plugin-elizacloud"),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --conditions=eliza-source --no-experimental-webstorage --disable-warning=ExperimentalWarning`.trim(),
    },
  }
);
writeFileSync(path.join(output, "output.log"), `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
if (result.error) throw result.error;
assert.equal(result.signal, null, "Image conformance was interrupted");
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
const checked = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(root, "plugins/plugin-elizacloud", file),
  [
    "native image funding retains one operation across retries and preserves prepaid and failure boundaries",
  ]
);
writeFileSync(path.join(output, "checked.json"), `${JSON.stringify(checked, null, 2)}\n`);
console.log("NativeImageOperation conformance passed actual image handler and SDK HTTP checks");
