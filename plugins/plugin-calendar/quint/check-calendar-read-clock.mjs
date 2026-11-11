import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../../packages/scripts/lib/vitest-conformance.ts";

const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
    ),
    "run",
    "--config",
    "plugins/plugin-personal-assistant/vitest.config.ts",
    "plugins/plugin-personal-assistant/test/calendar-action-effect-receipts.pglite.test.ts",
    "-t",
    "aliased read bounds|elapsed daily feed",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const briefing = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
    ),
    "run",
    "--config",
    "plugins/plugin-personal-assistant/vitest.config.ts",
    "plugins/plugin-personal-assistant/src/lifeops/checkin/checkin-availability.pglite.test.ts",
    "-t",
    "canonical Calendar feed|ordinary Gmail",
  ],
  { stdio: "inherit" },
);
if (briefing.error) throw briefing.error;
if (briefing.status !== 0) process.exit(briefing.status ?? 1);

const output = testOutputPath("quint-calendar-selected-read");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "selected.json");
const selected = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
    ),
    "run",
    "--config",
    "vitest.config.ts",
    "src/actions/calendar-read-selected.test.ts",
    "--cache=false",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
  },
);
if (selected.error) throw selected.error;
if (selected.status !== 0) process.exit(selected.status ?? 1);

assert.equal(
  selected.signal,
  null,
  "Selected Calendar conformance was interrupted",
);
requireVitestConformance(
  JSON.parse(readFileSync(report, "utf8")),
  fileURLToPath(
    new URL("../src/actions/calendar-read-selected.test.ts", import.meta.url),
  ),
  [
    "current selected canonical Calendar read reads a selected Google event through second-precision filters and emits its versioned receipt",
    "current selected canonical Calendar read refuses a selection replaced while its authorized feed read is pending",
    "current selected canonical Calendar read supplies the computed weekday for an all-day selected event",
    "current selected canonical Calendar read keeps the whole timed selected event and computes its date in America/Los_Angeles",
    "current selected canonical Calendar read keeps the whole timed selected event and computes its date in Pacific/Kiritimati",
    "current selected canonical Calendar read keeps the whole timed selected event and computes its date in UTC",
    "current selected canonical Calendar read preserves the all-day civil date when its canonical timestamp has an offset",
    "current selected canonical Calendar read refuses wrong-owner without returning record evidence",
    "current selected canonical Calendar read refuses wrong-view without returning record evidence",
    "current selected canonical Calendar read refuses sensitive without returning record evidence",
    "current selected canonical Calendar read refuses native-selection without returning record evidence",
    "current selected canonical Calendar read refuses stale-revision without returning record evidence",
    "current selected canonical Calendar read refuses wrong-source without returning record evidence",
    "current selected canonical Calendar read refuses revoked-source without returning record evidence",
    "current selected canonical Calendar read refuses partial-feed without returning record evidence",
    "current selected canonical Calendar read refuses missing-event without returning record evidence",
    "current selected canonical Calendar read refuses changed-event without returning record evidence",
    "current selected canonical Calendar read refuses duplicate-event without returning record evidence",
    "current selected canonical Calendar read binds only the host's current target and refuses a model-supplied target",
  ],
);
console.log(
  `Nineteen exact selected Calendar cases passed without skips. Evidence ${directory}`,
);
