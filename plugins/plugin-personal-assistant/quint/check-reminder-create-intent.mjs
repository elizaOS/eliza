import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const file =
  "plugins/plugin-personal-assistant/test/life-action-effect-receipts.integration.test.ts";
const output = testOutputPath("quint-reminder-create-intent");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "vitest.json");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "plugins/plugin-personal-assistant/vitest.src-integration.config.ts",
    file,
    "--maxWorkers=1",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const required = [
  "owner life action effect receipts — real PGlite delivers strict receipts through the canonical action executor",
  "owner life action effect receipts — real PGlite binds create, update, delete, and duplicate replay to repository truth",
  "owner life action effect receipts — real PGlite binds complete, skip, and snooze to exact persisted occurrence rows",
  "owner life action effect receipts — real PGlite marks goal review as noop and failed preconditions as rejected",
  "anchors an explicit one-shot reminder at its requested due time",
  "anchors a one-shot alarm on OWNER_TODOS with its expected lead",
  "anchors a one-shot unspecified on OWNER_REMINDERS with its expected lead",
  "anchors a one-shot unspecified on OWNER_TODOS with its expected lead",
  "persists an explicit in-app-only reminder without native projection",
  "does not create a timed reminder when destination recovery has no usable plan",
  "keeps unresolved destinations effect-free and preserves explicit Apple preference undefined",
  "keeps unresolved destinations effect-free and preserves explicit Apple preference apple_reminders",
  "keeps an unresolved reminder alert choice effect-free instead of treating a due time as an alert",
  "rejects a planner-supplied reminder for a Calendar-only owner request",
  "keeps an explicit reminder actionable after checking its owner request: Remind me in 2 minutes to check the notification in this app with an alert",
  "keeps an explicit reminder actionable after checking its owner request: Recuérdame revisar la notificación en esta app dentro de 2 minutos",
];
requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(root, file),
  required,
);
console.log("Original-request reminder conformance passed", directory);
