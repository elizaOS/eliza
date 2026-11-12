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
