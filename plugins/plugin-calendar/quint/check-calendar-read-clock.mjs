import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
