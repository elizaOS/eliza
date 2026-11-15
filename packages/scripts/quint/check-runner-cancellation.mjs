/** Exercises evidence retention, source binding and CLI process ownership. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = path.join(root, "packages/scripts/quint/RunnerCancellation.qnt");
if (
  process.argv.length > 3 ||
  (process.argv[2] && path.resolve(root, process.argv[2]) !== model)
) {
  throw new Error("Runner cancellation conformance requires its own model");
}
const outputRoot = testOutputPath("quint-runner-cancellation");
mkdirSync(outputRoot, { recursive: true });
const report = path.join(
  mkdtempSync(path.join(outputRoot, "run-")),
  "node-test.tap",
);
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "180000",
    "--",
    process.execPath,
    "--test",
    "--test-reporter=tap",
    path.join(root, "packages/scripts/check-quint.node.test.ts"),
    path.join(root, "packages/scripts/quint-cancellation.node.test.ts"),
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
writeFileSync(report, output);
// The nested schedules inspect /proc and intentionally run only on Linux.
// Keep their exact skip reason visible elsewhere, and require both on CI.
const nestedSuffix =
  process.platform === "linux" ? "$" : " # SKIP Linux process-group schedule$";
const expectedPasses = process.platform === "linux" ? 28 : 26;
const expectedSkips = process.platform === "linux" ? 0 : 2;
if (
  result.error ||
  result.signal ||
  result.status !== 0 ||
  !/^ok \d+ - CLI cancellation reaps checker descendants and retains incomplete evidence$/m.test(
    output,
  ) ||
  !/^ok \d+ - child cancellation stops later cases and remains visible in evidence$/m.test(
    output,
  ) ||
  !new RegExp(
    `^ok \\d+ - nested CLI cancellation reaps signal-ignoring checker descendants${nestedSuffix}`,
    "m",
  ).test(output) ||
  !new RegExp(
    `^ok \\d+ - nested CLI cancellation reaps descendants spawned after cancellation${nestedSuffix}`,
    "m",
  ).test(output) ||
  !/^ok \d+ - TLC state and action properties retain their checked outcomes$/m.test(
    output,
  ) ||
  !/^ok \d+ - an implementation conformance failure fails the shared run$/m.test(
    output,
  ) ||
  !/^ok \d+ - the shared runner rejects a failing scenario without the Test suffix$/m.test(
    output,
  ) ||
  !/^# tests 28$/m.test(output) ||
  !new RegExp(`^# pass ${expectedPasses}$`, "m").test(output) ||
  !/^# fail 0$/m.test(output) ||
  !new RegExp(`^# skipped ${expectedSkips}$`, "m").test(output) ||
  !/^# cancelled 0$/m.test(output)
) {
  throw new Error(`Runner cancellation conformance failed. Report ${report}`);
}
console.log(
  `Runner cancellation conformance passed ${expectedPasses} tests; ${expectedSkips} Linux-only schedules skipped. Report ${report}`,
);
