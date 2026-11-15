import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
execFileSync(
  process.execPath,
  [
    `${root}node_modules/vitest/vitest.mjs`,
    "run",
    "--config",
    "vitest.config.ts",
    "src/scheduled-task/sql-persistence.test.ts",
    "-t",
    "late consumer dispatcher",
  ],
  { cwd: `${root}plugins/plugin-scheduling`, stdio: "inherit" },
);
