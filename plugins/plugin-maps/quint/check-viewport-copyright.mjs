/** Run the real map plane through current, failed, late and disposed metadata replies. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = testOutputPath("quint-viewport-copyright");
await mkdir(output, { recursive: true });
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--experimental-transform-types",
    "plugins/plugin-maps/test/map-plane.test.mjs",
  ],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  },
);
const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
await writeFile(path.join(output, "tests.log"), log);
process.stdout.write(log);
if (result.error) throw result.error;
assert.equal(
  result.status,
  0,
  `Viewport copyright scenarios failed: ${result.signal}`,
);
assert.match(
  log,
  /Cloud copyright replies retire on movement and map disposal/,
);
