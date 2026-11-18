/** Source-bound socket-reuse measurement and the maintained Android API compile. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const output = testOutputPath("quint-speech-bootstrap");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const required = [
  "speech bootstrap and WebSocket reuse one TLS connection with the production client",
  "the product-subclassable speech bridge compiles with the library against Android 36",
];
const result = spawnSync(process.execPath, [
  "packages/scripts/run-with-deadline.ts", "240000", "--", process.execPath,
  "--test", "--test-reporter=tap",
  ...required.flatMap((name) => ["--test-name-pattern", `^${name}$`]),
  "packages/app/scripts/paradee-voice/speech-pipeline-contract.test.mjs",
], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
writeFileSync(path.join(directory, "transport.tap"), log);
if (result.error) throw result.error;
assert.equal(result.signal, null);
assert.equal(result.status, 0, `Speech transport conformance failed: ${directory}`);
assert.deepEqual([...log.matchAll(/^ok \d+ - (.+)$/gm)].map((match) => match[1]).sort(), [...required].sort());
assert.match(log, /^# tests 2$/m);
assert.match(log, /^# pass 2$/m);
assert.match(log, /^# skipped 0$/m);
console.log(`Speech bootstrap conformance passed. Evidence ${directory}`);
