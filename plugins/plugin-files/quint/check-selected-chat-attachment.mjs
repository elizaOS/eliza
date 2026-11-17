/** Actual browser selected-byte/revision checks and pure-Java bounded-stream suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_CHAT_IMAGE_INTAKE_BYTES } from "../../../packages/core/src/chat-upload-limits.ts";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
assert.equal(MAX_CHAT_IMAGE_INTAKE_BYTES, 20 * 1024 * 1024);
const output = testOutputPath("selected-chat-attachment");
mkdirSync(output, { recursive: true });
for (const [label, args, count] of [
  [
    "browser",
    [
      "--conditions=eliza-source",
      "--import",
      "tsx",
      "--test",
      "--test-concurrency=1",
      "--test-reporter=tap",
      "plugins/plugin-files/test/browser-files-share.test.mjs",
    ],
    12,
  ],
  [
    "native",
    [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=tap",
      "plugins/plugin-native-media/test/native-host/permitted-media.node.mjs",
    ],
    3,
  ],
]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(path.join(output, `${label}.tap`), text);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, text);
  assert.match(text, new RegExp(`^# pass ${count}$`, "m"));
  assert.match(text, /^# fail 0$/m);
  assert.match(text, /^# skipped 0$/m);
}
console.log(
  "Selected chat attachment conformance passed browser selection and Java byte bounds",
);
