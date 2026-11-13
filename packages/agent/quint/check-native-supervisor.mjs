/** Replays native supervisor ownership against real operating-system children. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = path.join(root, "packages/agent/quint/api-native-supervisor.qnt");
if (
  process.argv.length > 3 ||
  (process.argv[2] && path.resolve(root, process.argv[2]) !== model)
) {
  throw new Error("Native supervisor conformance requires its own model");
}
const required = [
  "private launch persists token, preserves user config and isolates actual child environment",
  "private launch rejects malformed settings, links and empty authority without spawning",
  "failed launch receipt reaps its actual child and removes signal handlers",
  "missing executable rejects without an unhandled child error or signal leak",
  "signal during receipt cancels admission and kills a child that ignores TERM",
  "runtime supervisor fences account rotation and close during real child startup",
  "runtime supervisor starts real processes in isolated account storage and stops only its child",
];
const producer = testOutputPath("quint-native-supervisor");
mkdirSync(producer, { recursive: true });
const report = path.join(
  mkdtempSync(path.join(producer, "run-")),
  "process-tests.tap",
);
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-with-deadline.ts"),
    "120000",
    "--",
    process.execPath,
    "--test",
    "--test-reporter=tap",
    "--test-name-pattern=^(private launch|failed launch receipt|missing executable|signal during receipt|runtime supervisor)",
    path.join(root, "packages/agent/native-host/gateway.e2e.test.mjs"),
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
writeFileSync(report, output);
const names = [...output.matchAll(/^ok \d+ - (.+)$/gm)].map(
  (match) => match[1],
);
if (
  result.error ||
  result.signal ||
  result.status !== 0 ||
  required.some((name) => !names.includes(name)) ||
  !/^# tests 7$/m.test(output) ||
  !/^# pass 7$/m.test(output) ||
  !/^# fail 0$/m.test(output) ||
  !/^# skipped 0$/m.test(output)
) {
  throw new Error(`Native supervisor conformance failed. Report ${report}`);
}
console.log(
  `Native supervisor conformance passed 7 real-process checks. Report ${report}`,
);
