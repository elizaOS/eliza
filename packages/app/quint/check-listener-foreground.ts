/** Require the production Java lifecycle and all owning Sense boundary checks. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = "packages/app/quint/ListenerForegroundLifecycle.qnt";
assert.equal(
  path.resolve(root, process.argv[2] ?? model),
  path.join(root, model),
);
const cases = model.replace(/\.qnt$/, ".cases.json");
const manifest = JSON.parse(readFileSync(path.join(root, cases), "utf8"));
const output = testOutputPath("quint-listener-foreground");
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
    "packages/app/test/android/sense.test.mjs",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const log = path.join(directory, "jvm.tap");
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.signal, null, `Sense conformance terminated: ${log}`);
assert.equal(child.status, 0, `Sense conformance failed: ${log}`);
const names = [
  "policy, crash loop, speech gate and configured wake phrase",
  "lease renewal, expiry, binder death, lock and AOD transitions",
  "stop, resume and stale queued invocation",
  "persistence failure and restart cannot revive stale consent",
  "SystemUI signer, owner, pause-only capability and independent visibility policy",
  "shared SystemUI source compiles and lease/acknowledgement fixtures execute",
  "all shared listener classes compile against Android 36",
  "exact listener foreground start and self-stop transitions settle refusal",
  "shared capture manifest retains network and capability boundaries",
];
const observed = [...child.stdout.matchAll(/^ok \d+ - (.+)$/gm)].map(
  (match) => match[1],
);
assert.deepEqual(observed.sort(), [...names].sort());
for (const [label, count] of [
  ["tests", 9],
  ["pass", 9],
  ["fail", 0],
  ["cancelled", 0],
  ["skipped", 0],
  ["todo", 0],
] as const)
  assert.match(child.stdout, new RegExp(`^# ${label} ${count}$`, "m"));
const sources = Object.fromEntries(
  [...new Set<string>([model, cases, ...manifest.sources])]
    .sort()
    .map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ]),
);
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ model, sources, names, log, boundary: "Exact Java lifecycle methods over controlled ports plus Android36 compilation; no APK/device/foreground-service platform acceptance." }, null, 2)}\n`,
);
console.log(
  `Nine Sense conformance cases passed, including six exact lifecycle scenarios. Evidence ${directory}`,
);
