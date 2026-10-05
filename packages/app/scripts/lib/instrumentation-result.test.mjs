import assert from "node:assert/strict";
import { test } from "node:test";
import { requireInstrumentationSuccess } from "./instrumentation-result.mjs";

const block = (code) =>
  `INSTRUMENTATION_STATUS: class=example.BridgeTest\nINSTRUMENTATION_STATUS: test=roundtrip\nINSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS_CODE: ${code}\n`;
const output = `${block(1) + block(0)}OK (1 test)\nINSTRUMENTATION_CODE: -1\n`;
test("instrumentation requires matched starts, successes and requested class coverage", () => {
  assert.equal(
    requireInstrumentationSuccess(output, ["example.BridgeTest"]).totalTests,
    1,
  );
  for (const broken of [
    output.replace(block(1), ""),
    output.replace(block(0), ""),
    output.replace("OK (1 test)", "OK (2 tests)"),
    output.replace("CODE: 0", "CODE: -3"),
    `${output}INSTRUMENTATION_CODE: -1\n`,
    `${output}INSTRUMENTATION_STATUS: class=example.BridgeTest\n`,
  ])
    assert.throws(() =>
      requireInstrumentationSuccess(broken, ["example.BridgeTest"]),
    );
  assert.throws(() =>
    requireInstrumentationSuccess(output, ["example.MissingTest"]),
  );
});
