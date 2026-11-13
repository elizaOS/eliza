/** Require the complete Chromium receipt for the draft adapter and controller. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert(process.argv.length <= 3, "Expected only the browser draft model path");
if (process.argv[2]) {
  assert.equal(
    path.resolve(process.argv[2]),
    path.join(root, "packages/ui/quint/BrowserDraftStorage.qnt"),
    "Browser draft conformance requires its own model",
  );
}
const output = testOutputPath("quint-browser-draft-storage");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const result = spawnSync(
  process.execPath,
  [
    "packages/scripts/run-with-deadline.ts",
    "180000",
    "--",
    process.execPath,
    "packages/ui/src/platform/__e2e__/run-browser-document-store.mjs",
    "chromium",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const log = path.join(directory, "chromium.log");
writeFileSync(log, `${result.stdout ?? ""}${result.stderr ?? ""}`);
if (result.error) throw result.error;
assert.equal(
  result.signal,
  null,
  `Browser draft conformance terminated: ${log}`,
);
assert.equal(result.status, 0, `Browser draft conformance failed: ${log}`);
const required = [
  "all 200 cross-tab updates and receipts retained",
  "concurrent initialization, stable tombstones, cancellation and quota failure pass",
  "initialization preserves an in-flight asynchronous editor",
  "creation conflict, reset ABA and exact corrupt-byte recovery pass",
  "editor failure, cancellation and failed transaction preserve saved bytes",
  "cancellation releases a hanging editor and rejects its late result",
  "draft adapter admits one cross-tab creator and keeps a revisioned clear",
  "draft adapter refuses an absent receipt after a tombstone wins",
  "abort after staged IndexedDB put rolls back and permits a draft retry",
  "late caller cancellation reports abort while retaining the committed draft",
  "same-key consume preserves the send receipt and non-dispatch recovery",
  "hold wins the queued same-key consume race",
  "separate-key consume acknowledges its clear before old send release",
  "stale cross-tab consume preserves the send mark and requires explicit recovery",
  "stale cross-tab hold preserves a consume clear pending host acknowledgement",
  "async conflict, tab death and reload recovery pass",
  "draft adapter reload preserves cleared rows and writes cancelled after dispatch",
  "browser restart keeps an unacknowledged release marked for review",
  "browser restart restores the exact confirmed release and reviewed draft",
];
const observed = result.stdout
  .split(/\r?\n/)
  .filter((line) => line.startsWith("chromium: "))
  .map((line) => line.slice("chromium: ".length));
assert.deepEqual(observed, required, `Incomplete browser draft groups: ${log}`);
const version = result.stdout.match(/^chromium browser (.+)$/m)?.[1];
assert(version, `Missing actual browser version: ${log}`);
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify({ engine: "chromium", version, groups: observed, log }, null, 2)}\n`,
);
console.log(
  `Chromium draft storage and controller passed all ${required.length} required groups. Receipt ${log}`,
);
