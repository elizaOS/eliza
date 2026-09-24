/** Exercises Android instrumentation completion and native module wiring without replacing device behavior. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  inventory,
  parseInstrumentation,
  parseNativeArtifacts,
} from "./android-native-plugins.mjs";

function result(code = 0, name = "roundTrip") {
  return `INSTRUMENTATION_STATUS: class=example.BridgeTest\nINSTRUMENTATION_STATUS: test=${name}\nINSTRUMENTATION_STATUS_CODE: ${code}\n`;
}
const completed = "INSTRUMENTATION_CODE: -1\n";

test("requires individual successful assertions and a completed run", () => {
  assert.equal(parseInstrumentation(result() + completed, 1).pass, true);
  assert.equal(parseInstrumentation(result(), 1).pass, false);
  assert.equal(parseInstrumentation(completed, 0).pass, false);
  assert.equal(
    parseInstrumentation(`OK (1 test)\n${completed}`, 1).pass,
    false,
  );
  assert.equal(parseInstrumentation(result() + completed, 2).pass, false);
});

test("skips, ignored tests, assertion failures and crashes fail the gate", () => {
  for (const code of [-4, -3, -2, -1]) {
    const parsed = parseInstrumentation(result(code) + completed, 1);
    assert.equal(parsed.pass, false);
    assert.equal(parsed.tests[0].status, code <= -3 ? "skipped" : "failed");
  }
  assert.equal(
    parseInstrumentation(
      result() +
        "INSTRUMENTATION_RESULT: shortMsg=Process crashed.\n" +
        completed,
      1,
    ).pass,
    false,
  );
});

test("start events do not count as tests and duplicate finishes fail", () => {
  assert.equal(
    parseInstrumentation(result(1) + result() + completed, 1).pass,
    true,
  );
  assert.equal(
    parseInstrumentation(result() + result() + completed, 2).pass,
    false,
  );
});

test("discovers all Android modules and exposes missing device coverage", () => {
  const plugins = inventory();
  assert.ok(plugins.some((plugin) => plugin.android));
  assert.ok(plugins.some((plugin) => !plugin.android));
  for (const plugin of plugins.filter((plugin) => plugin.android)) {
    assert.ok(
      plugin.tests.length > 0,
      `${plugin.directory} needs device tests`,
    );
  }
});

test("exports complete device artifact bytes without counting status bundles as tests", () => {
  const bytes = Buffer.from([0, 1, 2, 128, 255]);
  const output = `INSTRUMENTATION_STATUS: nativeArtifactName=screen.png\nINSTRUMENTATION_STATUS: nativeArtifactBase64=${bytes.toString("base64")}\nINSTRUMENTATION_STATUS_CODE: 2\n`;
  assert.deepEqual(parseNativeArtifacts(output), [
    { name: "screen.png", bytes },
  ]);
  assert.equal(
    parseInstrumentation(output + result() + completed, 1).pass,
    true,
  );
});

test("rejects unsafe, duplicate, corrupt and incomplete native artifacts", () => {
  const status = (name, data = "AQI=") =>
    `INSTRUMENTATION_STATUS: nativeArtifactName=${name}\nINSTRUMENTATION_STATUS: nativeArtifactBase64=${data}\nINSTRUMENTATION_STATUS_CODE: 2\n`;
  for (const name of [
    "../screen.png",
    "/screen.png",
    "nested/screen.png",
    "screen.exe",
  ])
    assert.throws(() => parseNativeArtifacts(status(name)));
  assert.throws(() => parseNativeArtifacts(status("screen.png", "corrupt!")));
  assert.throws(() =>
    parseNativeArtifacts(
      "INSTRUMENTATION_STATUS: nativeArtifactName=first.png\n" +
        status("screen.png"),
    ),
  );
  assert.throws(() =>
    parseNativeArtifacts(status("screen.png") + status("screen.png")),
  );
  assert.throws(() =>
    parseNativeArtifacts(
      "INSTRUMENTATION_STATUS: nativeArtifactName=screen.png\n",
    ),
  );
});
