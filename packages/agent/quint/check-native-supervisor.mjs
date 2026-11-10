/** Checks native child ownership and account migration against real processes and disk. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const processCase =
  "runtime supervisor starts real processes in isolated account storage and stops only its child";
const supervisorCases = [
  "private launch persists token, preserves user config and isolates actual child environment",
  "private launch rejects malformed settings, links and empty authority without spawning",
  "failed launch receipt reaps its actual child and removes signal handlers",
  "missing executable rejects without an unhandled child error or signal leak",
  "signal during receipt cancels admission and kills a child that ignores TERM",
  "runtime supervisor fences account rotation and close during real child startup",
  processCase,
];
const migrationCases = [
  "account migration preserves private namespaces and unrelated disk state",
  "account migration resumes after a disk rejection without rewriting clean files",
  "account migration rejects unsafe entries and preserves their real disk targets",
  processCase,
];
const modelPath = (name) => path.join(root, "packages/agent/quint", name);
const supervisorModel = modelPath("api-native-supervisor.qnt");
const migrationModel = modelPath("NativeAccountMigration.qnt");
const model = path.resolve(root, process.argv[2] ?? supervisorModel);
if (
  process.argv.length > 3 ||
  ![supervisorModel, migrationModel].includes(model)
)
  throw new Error("Native host conformance requires a supported model");
const migration = model === migrationModel;
const required = migration ? migrationCases : supervisorCases;
const producer = testOutputPath(
  migration ? "quint-native-account-migration" : "quint-native-supervisor",
);
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
    migration
      ? "--test-name-pattern=^(account migration|runtime supervisor starts real processes)"
      : "--test-name-pattern=^(private launch|failed launch receipt|missing executable|signal during receipt|runtime supervisor)",
    path.join(root, "packages/agent/native-host/gateway.e2e.test.mjs"),
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
writeFileSync(report, output);
const names = [...output.matchAll(/^ok \d+ - (.+)$/gm)].map(
  (match) => match[1],
);
const receipts = new Set(output.split(/\r?\n/));
if (
  result.error ||
  result.signal ||
  result.status !== 0 ||
  required.some((name) => !names.includes(name)) ||
  names.length !== required.length ||
  !receipts.has(`# tests ${required.length}`) ||
  !receipts.has(`# pass ${required.length}`) ||
  !receipts.has("# fail 0") ||
  !receipts.has("# skipped 0") ||
  !receipts.has("# cancelled 0")
) {
  throw new Error(`Native host conformance failed. Report ${report}`);
}
console.log(
  `${path.basename(model)} conformance passed ${required.length} disk/process checks. Report ${report}`,
);
