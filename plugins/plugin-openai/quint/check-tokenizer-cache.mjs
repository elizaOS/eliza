/** Runs all named checks for the OpenAI encoder cache against production code. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const plugin = path.join(root, "plugins/plugin-openai");
const model = path.join(plugin, "quint/OpenAITokenizerCache.qnt");
if (process.argv[2]) assert.equal(path.resolve(process.argv[2]), model);

const test = "__tests__/lazy-tokenizer.test.ts";
const expected = [
  "the plugin root loads no rank table until a tokenizer handler runs",
  "a tokenizer call loads only the encoding its model uses and caches it",
  "shares a pending import and retries its rejection without evicting another encoding",
  "keeps the fallback encodings for model names outside the registry",
].map((name) => `tokenizer loading ${name}`);

const outputRoot = testOutputPath("quint-openai-tokenizer");
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(path.join(outputRoot, "conformance-"));
const report = path.join(output, "vitest.json");
const config = path.join(output, "vitest.config.mjs");
writeFileSync(
  config,
  [
    `import base from ${JSON.stringify(path.join(plugin, "vitest.config.ts"))};`,
    `import { buildWorkspaceSourceAliases } from ${JSON.stringify(path.join(root, "packages/scripts/vitest/source-aliases.ts"))};`,
    `export default {...base, root: ${JSON.stringify(plugin)}, resolve: {...base.resolve, alias:[...buildWorkspaceSourceAliases(${JSON.stringify(root)}), ...(base.resolve?.alias ?? [])]}};`,
  ].join("\n"),
);
const result = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    config,
    test,
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { cwd: plugin, encoding: "utf8", timeout: 150_000, maxBuffer: 16 * 1024 * 1024 },
);
const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
writeFileSync(path.join(output, "output.log"), log);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(result.status, 0, log);

const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, test),
  expected,
);
writeFileSync(
  path.join(output, "checked.json"),
  `${JSON.stringify(checks, null, 2)}\n`,
);
console.log(`OpenAI tokenizer cache conformance passed all ${checks.length} named checks`);
