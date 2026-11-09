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
const suites = [
  {
    directory: "plugins/plugin-elizacloud",
    file: "__tests__/embedding-routing.test.ts",
    names: [
      "Eliza Cloud embedding routing does not register cloud embeddings when ELIZAOS_CLOUD_USE_EMBEDDINGS=false so BYO embeddings resolve",
      "Eliza Cloud embedding routing keeps Cloud embeddings separate from Direct media",
    ],
  },
  {
    directory: "packages/agent",
    file: "test/provider-switch-cloud-proxy-env.test.ts",
    names: [
      "stops routing OpenAI requests through the Eliza Cloud proxy after switching to OpenAI",
      "stops routing Anthropic requests through the Eliza Cloud proxy after switching to Anthropic",
      "keeps an embedding-only Cloud route from taking Direct photo and speech slots at boot",
      "sends the next openai model request to the direct provider host after leaving Eliza Cloud",
      "sends the next anthropic model request to the direct provider host after leaving Eliza Cloud",
      "sends chat to the new provider after a chat-brain pin and a provider switch",
    ],
  },
];
let count = 0;
for (const [index, suite] of suites.entries()) {
  const report = path.join(output, `vitest-${index}.json`);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-vitest.ts"),
      "run",
      "--config",
      "vitest.config.ts",
      "--no-file-parallelism",
      suite.file,
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    {
      cwd: path.join(root, suite.directory),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ""} --conditions=eliza-source --no-experimental-webstorage --disable-warning=ExperimentalWarning`.trim(),
      },
    }
  );
  writeFileSync(
    path.join(output, `output-${index}.log`),
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  );
  if (result.error) throw result.error;
  assert.equal(result.signal, null, "Conformance process was interrupted");
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const checks = requireVitestConformance(
    JSON.parse(readFileSync(report, "utf8")),
    path.join(root, suite.directory, suite.file),
    suite.names
  );
  writeFileSync(path.join(output, `checked-${index}.json`), `${JSON.stringify(checks, null, 2)}\n`);
  count += checks.length;
}
console.log(`CloudCapabilities conformance passed ${count} registration and boot checks`);
