import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const commands = [
  [
    process.env.ALPHA_BUN || "bun",
    [
      "test",
      "packages/cloud/shared/src/lib/services/agent-google-connector/calendar.etag.test.ts",
    ],
  ],
  [
    process.execPath,
    ["--test", "packages/app/test/native-host/managed-google-agent.test.mjs"],
  ],
  [
    process.execPath,
    [
      `${root}/node_modules/vitest/vitest.mjs`,
      "run",
      "--config",
      "plugins/plugin-personal-assistant/vitest.config.ts",
      "plugins/plugin-personal-assistant/src/lifeops/checkin/checkin-availability.pglite.test.ts",
      "--maxWorkers=1",
      "-t",
      "old Google cache refreshes",
    ],
  ],
];
for (const [binary, args] of commands) {
  const result = spawnSync(binary, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    "Calendar provider revision conformance failed",
  );
}
