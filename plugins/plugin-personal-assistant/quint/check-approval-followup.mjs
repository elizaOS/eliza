import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const file =
  "plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.integration.test.ts";
const output = testOutputPath("quint-approval-followup");
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
  "processDueScheduledTasks \u2014 production wiring resolves owner-local cron timezone priority -1/-1/1/0",
  "processDueScheduledTasks \u2014 production wiring limits resolved approval cleanup to one task per tick without delivering deferred approvals",
  "processDueScheduledTasks \u2014 production wiring retires a resolved approval's scheduled follow-up before dispatch or escalation",
  "processDueScheduledTasks \u2014 production wiring retires a resolved approval's fired follow-up before dispatch or escalation",
  "processDueScheduledTasks \u2014 production wiring fires a due one-shot reminder via the real runner wired through LifeOpsRepository",
  "processDueScheduledTasks \u2014 production wiring fires owner-local cron after travel changes the zone despite a future home-zone index",
  "processDueScheduledTasks \u2014 production wiring reconciles a stale bound fire after restart by replaying its provider receipt",
  "processDueScheduledTasks \u2014 production wiring respectsGlobalPause via the real GlobalPauseStore: paused tasks skip, then fire after clear()",
  "processDueScheduledTasks \u2014 production wiring two parallel ticks on the same ready task fire it exactly once",
  "processDueScheduledTasks \u2014 production wiring fires a recurring checkin (interval) and recomputes next_fire_at",
  "processDueScheduledTasks \u2014 production wiring fires a followup (after_task) via a due scheduled-override",
  "processDueScheduledTasks \u2014 production wiring fires an approval through runner.schedule and auto-defaults followupAfterMinutes + records a pending prompt",
  "processDueScheduledTasks \u2014 production wiring completes a fired user_replied_within task from an owner MESSAGE_RECEIVED event",
  "processDueScheduledTasks \u2014 production wiring leaves a fired user_replied_within task open when no reply arrived before timeout",
  "processDueScheduledTasks \u2014 production wiring completes subject_updated during the production tick before timeout skip",
  "processDueScheduledTasks \u2014 production wiring fires a watcher (event) via a due scheduled-override",
  "processDueScheduledTasks \u2014 production wiring fires an output (once) task and persists the fired transition",
  "processDueScheduledTasks \u2014 production wiring times out an unanswered approval through no-reply expiry without spawning pipeline.onSkip",
  "processDueScheduledTasks \u2014 production wiring circadian_state_in gate falls through to allow and the task fires with a warn-once fallback",
  "does not deliver a scheduled task the owner dismissed while its message was rendered",
];
requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  path.join(root, file),
  required,
);
console.log("Approval follow-up conformance passed", directory);
