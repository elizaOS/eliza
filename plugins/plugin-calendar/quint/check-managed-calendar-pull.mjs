import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
    ),
    "run",
    "plugins/plugin-calendar/test/calendar-managed-default-feed.pglite.test.ts",
    "-t",
    "pulls a mapped managed edit and deletion",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const cache = spawnSync(process.execPath, [
  fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url)),
  "run", "--config", "vitest.config.ts", "src/service/managed-calendar-read-diagnostic.test.ts",
  "-t", "keeps a managed feed event",
], { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit" });
if (cache.error) throw cache.error;
if (cache.status !== 0) process.exit(cache.status ?? 1);
