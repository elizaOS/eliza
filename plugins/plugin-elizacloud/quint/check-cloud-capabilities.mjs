/** Run the existing Cloud/Direct registration contract against real plugin functions. */
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
    path.join(root, "plugins/plugin-elizacloud/quint/CloudCapabilities.qnt")
  );
const outputRoot = testOutputPath("quint-cloud-capabilities");
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(path.join(outputRoot, "conformance-"));
const report = path.join(output, "vitest.json");
const test = "__tests__/embedding-routing.test.ts";
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-vitest.ts"),
    "run",
    "--config",
    "vitest.config.ts",
    "--no-file-parallelism",
    test,
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
assert.equal(result.signal, null, "Conformance process was interrupted");
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(root, "plugins/plugin-elizacloud", test),
  [
    "Eliza Cloud embedding routing does not register cloud embeddings when ELIZAOS_CLOUD_USE_EMBEDDINGS=false so BYO embeddings resolve",
    "Eliza Cloud embedding routing keeps Cloud embeddings separate from Direct media",
  ]
);
writeFileSync(path.join(output, "checked.json"), `${JSON.stringify(checks, null, 2)}\n`);
console.log(`CloudCapabilities conformance passed ${checks.length} registration checks`);
