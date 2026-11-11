/** Checks the real service and SDK against the loopback Bot API. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const plugin = path.join(root, "plugins/plugin-telegram");
const model = path.join(plugin, "quint/TelegramCancellation.qnt");
if (process.argv[2]) assert.equal(path.resolve(process.argv[2]), model);
const test = "src/service.start-retry.test.ts";
const required = [
  ...["native", "legacy", "custom"].flatMap((kind) =>
    ["pre-abort", "request-started"].map(
      (timing) => `cleans up ${kind} ${timing} cancellation`,
    ),
  ),
  "owns concurrent calls with distinct signals",
  "owns concurrent calls with shared signals",
  "preserves a native timeout after the request starts",
  "cleans up successful and failed requests and keeps SDK errors",
  "keeps external Composer contexts and cancels the update client",
].map((name) => `TelegramService cancellation ${name}`);
const existing = [
  ...[
    "installs shutdown hooks only after Telegraf assigns a stoppable poller",
    "handles updates while retrying a post-launch startup probe",
    "registers commands, handlers, and shutdown hooks once across an injected retry",
    "completes all four one-shot wiring steps inside initializeBot",
    "fails fast with a typed error when initializeBot has no account state",
  ].map((name) => `TelegramService startup wiring ${name}`),
  ...[
    "stops polling after a transient failure retries startup",
    "receives a button tap while the turn that asked for it is still running",
    "aborts a turn that waits for a tap before it drains on stop",
    "stops polling on the unchanged happy path",
  ].map((name) => `TelegramService poller lifecycle ${name}`),
];
const outputRoot = testOutputPath("quint-telegram-cancellation");
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(path.join(outputRoot, "conformance-"));
const report = path.join(output, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    "--conditions=eliza-source",
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    test,
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: plugin,
    encoding: "utf8",
    timeout: 150_000,
    maxBuffer: 16 * 1024 * 1024,
  },
);
const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
writeFileSync(path.join(output, "output.log"), log);
if (result.error) throw result.error;
assert.equal(result.signal, null, log);
assert.equal(result.status, 0, log);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(plugin, test),
  [...required, ...existing],
);
writeFileSync(
  path.join(output, "checked.json"),
  `${JSON.stringify(checks, null, 2)}\n`,
);
console.log(
  `Telegram service conformance passed all ${checks.length} named checks`,
);
