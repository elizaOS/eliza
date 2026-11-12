/** Require the complete public warmup-client regression suite. */
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
    path.join(root, "plugins/plugin-elizacloud/quint/CloudWarmup.qnt")
  );
const expected = [
  "sends one explicit authenticated warmup without a prompt",
  "debounces to once per 60s, including concurrent triggers",
  "does not suppress a newly selected account's warmup",
  "does nothing when another provider owns text or Cloud has no key",
  "reports a network failure as unreachable and still debounces",
  "does not report an unsupported warm endpoint as warmed",
  "is registered as POST /api/cloud/warm on the route plugin",
].map((name) => `cloud inference pre-warm ${name}`);
const outputRoot = testOutputPath("quint-cloud-warmup");
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(path.join(outputRoot, "conformance-"));
const report = path.join(output, "vitest.json");
const test = "src/routes/cloud-warm-route.test.ts";
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
  expected
);
writeFileSync(path.join(output, "checked.json"), `${JSON.stringify(checks, null, 2)}\n`);
console.log(`CloudWarmup conformance passed ${checks.length} named public-client checks`);
