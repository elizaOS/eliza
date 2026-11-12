import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(
    root,
    "plugins/plugin-local-inference/quint/ProcessLocalMicrophone.qnt",
  ),
);
const result = execFileSync(
  process.execPath,
  [
    "--test",
    "--test-reporter=tap",
    "--test-name-pattern=^local microphone owners compete",
    "packages/app/scripts/paradee-voice/speech-pipeline-contract.test.mjs",
  ],
  { cwd: root, encoding: "utf8", timeout: 180_000 },
);
assert.match(result, /^ok 1 - local microphone owners compete/m);
assert.match(result, /^# pass 12$/m);
assert.match(result, /^# fail 0$/m);
assert.match(result, /^# skipped 0$/m);
process.stdout.write(result);
