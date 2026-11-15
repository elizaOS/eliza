import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const env = { ...process.env };
if (!env.ELIZA_ORG_JSON_JAR && env.ELIZA_JSON_JAR)
  env.ELIZA_ORG_JSON_JAR = env.ELIZA_JSON_JAR;
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "plugins/plugin-native-action-journal/test/native-host/journal.node.mjs",
  ],
  {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    encoding: "utf8",
    env,
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  },
);
assert.ifError(result.error);
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /tests 2\b/);
assert.match(result.stdout, /pass 2\b/);
assert.match(
  result.stdout,
  /skipped 0\b/,
  "The actual JVM suite must run, not skip",
);
process.stdout.write(`${result.stdout}${result.stderr}`);
