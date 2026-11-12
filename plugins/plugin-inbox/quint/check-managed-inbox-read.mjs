import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
for (const [config, file, pattern] of [
  [
    "plugins/plugin-inbox/vitest.config.ts",
    "plugins/plugin-inbox/test/inbox-aggregate.real-runtime.test.ts",
    "host-selected Gmail|failed managed Gmail",
  ],
  [
    "plugins/plugin-personal-assistant/vitest.config.ts",
    "plugins/plugin-personal-assistant/src/lifeops/checkin/checkin-availability.pglite.test.ts",
    "current managed Gmail mailbox",
  ],
]) {
  const result = spawnSync(
    process.execPath,
    [
      `${root}/node_modules/vitest/vitest.mjs`,
      "run",
      "--config",
      config,
      file,
      "--maxWorkers=1",
      "-t",
      pattern,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    "Managed Inbox implementation conformance failed",
  );
}
