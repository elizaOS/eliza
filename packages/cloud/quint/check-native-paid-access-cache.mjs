/** Require the real native HTTP/private-file SDK and gateway regressions. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const files = [
  "packages/cloud/sdk/native-host/cloud-services.test.mjs",
  "packages/agent/native-host/gateway.e2e.test.mjs",
];
const required = [
  "a warm paid check asks Cloud nothing and refreshes the cache afterwards",
  "a cached refusal is checked live, so an upgrade admits the next request at once",
  "the paid-access cache never answers for another account",
  "a late identity refusal keeps a replacement private-file credential",
  "one live check serves concurrent cold requests, and background checks coalesce",
  "sign-out, sign-in, revocation and a refused paid call drop the cached answer",
  "a refusal during a background check schedules another, and settling waits for it",
  "the access route shares the live check and keeps the paid cache warm",
  "a paid route that Cloud refuses tells the Cloud routes to drop their cached answer",
];
const model = "packages/cloud/quint/NativePaidAccessCache.qnt";
assert.equal(
  path.resolve(root, process.argv[2] ?? model),
  path.join(root, model),
);
const output = testOutputPath("quint-native-paid-access-cache");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "180000",
    "--",
    process.execPath,
    "--test",
    "--test-reporter=tap",
    ...files,
  ],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  },
);
const log = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
const logPath = path.join(directory, "native-tests.log");
writeFileSync(logPath, log);
if (child.error) throw child.error;
assert.equal(child.signal, null, `Native conformance stopped: ${child.signal}`);
assert.equal(child.status, 0, `Native conformance failed. See ${logPath}`);
for (const kind of ["fail", "cancelled", "skipped", "todo"])
  assert.match(log, new RegExp(`^# ${kind} 0$`, "m"), `${kind}: ${logPath}`);
const total = Number(log.match(/^# tests (\d+)$/m)?.[1]);
const passed = Number(log.match(/^# pass (\d+)$/m)?.[1]);
assert(total > 0 && passed === total, `Incomplete native suite: ${logPath}`);
for (const name of required) {
  const literal = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(log, new RegExp(`^ok \\d+ - ${literal}$`, "m"), name);
}
const inputs = Object.fromEntries(
  [model, model.replace(/\.qnt$/, ".cases.json"), ...files].map((file) => [
    file,
    createHash("sha256")
      .update(readFileSync(path.join(root, file)))
      .digest("hex"),
  ]),
);
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ model, inputs, total, passed, required, log: logPath }, null, 2)}\n`,
);
console.log(
  `Native paid-cache conformance passed ${passed} tests. Evidence ${directory}`,
);
