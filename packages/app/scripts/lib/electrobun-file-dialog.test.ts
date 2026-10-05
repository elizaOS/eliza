/** Exercises the installed desktop SDK's file-selection API in an isolated Bun process with a controlled native-dialog boundary. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("file selection distinguishes cancellation, selected paths, and native failure", () => {
  const result = spawnSync(
    "bun",
    [
      "-e",
      `
import assert from "node:assert/strict";
import { mock } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.resolve("electrobun/bun")));
let nativeResult = "";
let nativeFailure;
mock.module(join(root, "proc/native.ts"), () => ({
  native: {},
  ffi: { request: { openFileDialog: () => {
    if (nativeFailure) throw nativeFailure;
    return nativeResult;
  } } },
}));
const { openFileDialog } = await import(join(root, "core/Utils.ts"));
assert.deepEqual(await openFileDialog(), []);
nativeResult = null;
assert.deepEqual(await openFileDialog(), []);
nativeResult = "/tmp/first file.txt,/tmp/second.txt";
assert.deepEqual(await openFileDialog(), ["/tmp/first file.txt", "/tmp/second.txt"]);
nativeFailure = new Error("native dialog unavailable");
await assert.rejects(openFileDialog(), error => error === nativeFailure);
`,
    ],
    {
      cwd: fileURLToPath(
        new URL("../../platforms/electrobun/", import.meta.url),
      ),
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
