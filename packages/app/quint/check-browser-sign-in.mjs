import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Exercise real middleware and emitted scripts. The maintained scenarios cover
// refusal, exact callback/state admission, expiry, consumption and isolation.
const result = spawnSync(
  "bun",
  [
    "--conditions=eliza-source",
    "test",
    "packages/cloud/scripts/pages-browser-sign-in.test.ts",
    "packages/cloud/scripts/pages-native-auth-callbacks.test.ts",
  ],
  {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  },
);
assert.ifError(result.error);
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
process.stdout.write(`${result.stdout}${result.stderr}`);
