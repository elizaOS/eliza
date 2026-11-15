/** Replays real observer process ownership through the existing Python suite. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = path.join(
  root,
  "packages/cloud/quint/vast_worker_supervision.qnt",
);
if (
  process.argv.length > 3 ||
  (process.argv[2] && path.resolve(root, process.argv[2]) !== model)
) {
  throw new Error("Vast worker conformance requires its own model");
}
const output = testOutputPath("quint-vast-worker");
mkdirSync(output, { recursive: true });
const report = path.join(mkdtempSync(path.join(output, "run-")), "python.log");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "120000",
    "--",
    "python3",
    "-m",
    "unittest",
    "discover",
    "-s",
    "tests",
    "-p",
    "test_observability.py",
    "-v",
  ],
  {
    cwd: path.join(root, "packages/cloud/services/vast-pyworker"),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  },
);
const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
writeFileSync(report, log);
const required = [
  "test_existing_heartbeat_cli_finishes_requested_iterations",
  "test_full_bootstrap_reuses_observers_preserves_history_and_stops_all_writers",
];
if (
  result.error ||
  result.signal ||
  result.status !== 0 ||
  !/Ran 2 tests/.test(log) ||
  !/\nOK\s*$/.test(log) ||
  required.some((name) => !new RegExp(`${name} .* \\.\\.\\. ok`).test(log))
) {
  throw new Error(`Vast worker process conformance failed. Report ${report}`);
}
console.log(
  `Vast worker conformance passed 2 real-process tests. Report ${report}`,
);
