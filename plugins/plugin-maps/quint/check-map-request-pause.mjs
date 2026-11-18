import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(root, "plugins/plugin-maps/quint/MapRequestPause.qnt"),
);
const output = testOutputPath("quint-map-request-pause");
mkdirSync(output, { recursive: true });
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--experimental-transform-types",
    "plugins/plugin-maps/test/cloud-maps-client.test.mjs",
  ],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 60_000,
  },
);
writeFileSync(
  path.join(output, "tests.log"),
  `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
);
assert.equal(
  result.status,
  0,
  "Maps request-pause implementation checks failed",
);
