/** Compare the finite direct-RPC observations with the real HTTP reader. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const plugin = path.join(root, "plugins/plugin-wallet");
const model = path.join(plugin, "quint/EvmBalanceRead.qnt");
if (process.argv[2]) assert.equal(path.resolve(process.argv[2]), model);
const test = "src/analytics/evm-balances-erc20-errors.test.ts";
const expected = [
  "reports failed ERC-20 reads instead of an empty token list",
  "keeps an empty tracked token list healthy without token RPC calls",
  "keeps a genuine zero ERC-20 balance a healthy empty token list",
  "keeps a real balance when only the symbol call reverts",
  "keeps a zero balance healthy when only the token metadata reverts",
  ...["undefined", "null", "0x", "17", "0xzz", "0x100"].map(
    (value) => `reports unreadable decimals ${value} instead of assuming 18`,
  ),
  "reports empty balance return data instead of a healthy zero",
  "reports incomplete holdings when only one token read fails",
  "retries an incomplete holdings read against the next RPC endpoint",
  "uses the full uint8 decimal range without guessing a scale",
];
const outputRoot = testOutputPath("quint-wallet-evm-balances");
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(path.join(outputRoot, "conformance-"));
const report = path.join(output, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-vitest.ts"),
    "run",
    "--config",
    path.join(plugin, "vitest.config.ts"),
    test,
    "--fsModuleCachePath",
    path.join(output, "module-cache"),
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: plugin,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  },
);
const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
writeFileSync(path.join(output, "output.log"), log);
if (result.error) throw result.error;
assert.equal(result.signal, null, `Conformance terminated: ${result.signal}`);
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
console.log(
  `Direct RPC balance conformance passed all ${checks.length} named checks`,
);
