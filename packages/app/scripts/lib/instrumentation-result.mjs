import assert from "node:assert/strict";

/** Parse raw `am instrument -w -r` output; class counts are not test counts. */
export function requireInstrumentationSuccess(output, requestedClasses) {
  assert.equal(typeof output, "string");
  assert.ok(
    output.length <= 4 * 1024 * 1024,
    "Instrumentation output exceeds bound",
  );
  assert.ok(Array.isArray(requestedClasses) && requestedClasses.length > 0);
  const requested = new Set(requestedClasses);
  assert.equal(
    requested.size,
    requestedClasses.length,
    "Duplicate requested class",
  );
  const text = output.replace(/\r\n?/g, "\n");
  assert.doesNotMatch(
    text,
    /FAILURES|INSTRUMENTATION_FAILED|Process crashed|AssumptionViolated/,
    "Failed or skipped instrumentation",
  );
  const terminal = [...text.matchAll(/^INSTRUMENTATION_CODE: (-?\d+)\s*$/gm)];
  assert.equal(terminal.length, 1, "Require one final instrumentation result");
  assert.equal(
    terminal[0][1],
    "-1",
    "Instrumentation did not finish successfully",
  );
  const summaries = [...text.matchAll(/^OK \((\d+) tests?\)\s*$/gm)];
  assert.equal(summaries.length, 1, "Require one test summary");
  const count = Number(summaries[0][1]);
  assert.ok(Number.isSafeInteger(count) && count > 0, "No tests executed");
  let fields = new Map(),
    active = null;
  const cases = [],
    seen = new Set(),
    covered = new Set();
  for (const line of text.split("\n")) {
    const field = /^INSTRUMENTATION_STATUS: ([A-Za-z][A-Za-z0-9_]*)=(.*)$/.exec(
      line,
    );
    if (field) {
      assert.ok(!fields.has(field[1]), "Duplicate status field");
      fields.set(field[1], field[2]);
      continue;
    }
    const status = /^INSTRUMENTATION_STATUS_CODE: (-?\d+)\s*$/.exec(line);
    if (!status) continue;
    const code = Number(status[1]);
    assert.ok(
      code === 1 || code === 0,
      "Skipped, failed or unsupported status",
    );
    const cls = fields.get("class"),
      method = fields.get("test");
    assert.ok(requested.has(cls), "Unexpected or missing class");
    assert.ok(
      typeof method === "string" && method.length > 0,
      "Missing test identity",
    );
    assert.equal(
      fields.get("numtests"),
      String(count),
      "Advertised count differs from final summary",
    );
    const selector = `${cls}#${method}`;
    if (code === 1) {
      assert.equal(active, null, "Overlapping starts");
      assert.ok(!seen.has(selector), "Duplicate test start");
      seen.add(selector);
      active = selector;
    } else {
      assert.equal(active, selector, "Success without matching start");
      cases.push(selector);
      covered.add(cls);
      active = null;
    }
    fields = new Map();
  }
  assert.equal(fields.size, 0, "Unterminated status block");
  assert.equal(active, null, "Test never finished");
  assert.equal(cases.length, count, "Completed count mismatch");
  assert.equal(seen.size, count, "Started count mismatch");
  assert.deepEqual(
    [...covered].sort(),
    [...requested].sort(),
    "Requested class missing",
  );
  const finalOffset = terminal[0].index;
  assert.ok(
    !/^INSTRUMENTATION_STATUS(?:_CODE)?:/m.test(
      text.slice(finalOffset + terminal[0][0].length),
    ),
    "Test statuses after final result",
  );
  return {
    passed: true,
    totalTests: count,
    started: seen.size,
    completed: cases.length,
    classes: [...covered].sort(),
    cases,
  };
}

/** A started single test ended by proven external interruption, never a passing test. */
export function requireInstrumentationInterruption(
  output,
  testClass,
  testMethod,
) {
  assert.equal(typeof output, "string");
  assert.ok(output.length <= 4 * 1024 * 1024);
  assert.match(
    testClass ?? "",
    /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/,
  );
  assert.match(testMethod ?? "", /^[A-Za-z][A-Za-z0-9_]*$/);
  const text = output.replace(/\r\n?/g, "\n");
  assert.doesNotMatch(
    text,
    /FAILURES|INSTRUMENTATION_FAILED|AssumptionViolated|^OK \(/m,
  );
  const statuses = [
    ...text.matchAll(/^INSTRUMENTATION_STATUS_CODE: (-?\d+)\s*$/gm),
  ];
  assert.equal(
    statuses.length,
    1,
    "Require exactly one interrupted test start",
  );
  assert.equal(
    statuses[0][1],
    "1",
    "Test completed or failed before interruption",
  );
  assert.doesNotMatch(
    text.slice(0, statuses[0].index),
    /^INSTRUMENTATION_(?:RESULT|CODE):/m,
  );
  const fields = new Map();
  for (const match of text
    .slice(0, statuses[0].index)
    .matchAll(/^INSTRUMENTATION_STATUS: ([A-Za-z][A-Za-z0-9_]*)=(.*)$/gm)) {
    assert.ok(!fields.has(match[1]), "Duplicate interrupted status field");
    fields.set(match[1], match[2]);
  }
  assert.equal(fields.get("class"), testClass);
  assert.equal(fields.get("test"), testMethod);
  assert.equal(fields.get("numtests"), "1");
  const tail = text.slice(statuses[0].index + statuses[0][0].length);
  assert.doesNotMatch(tail, /^INSTRUMENTATION_STATUS:/m);
  const terminals = [...tail.matchAll(/^INSTRUMENTATION_CODE: (-?\d+)\s*$/gm)];
  assert.equal(
    terminals.length,
    1,
    "Missing or ambiguous interrupted terminal result",
  );
  assert.equal(terminals[0][1], "0");
  assert.equal(
    [
      ...tail.matchAll(
        /^INSTRUMENTATION_RESULT: shortMsg=Process crashed\.\s*$/gm,
      ),
    ].length,
    1,
  );
  assert.doesNotMatch(
    tail.slice(terminals[0].index + terminals[0][0].length),
    /^INSTRUMENTATION_/m,
  );
  return {
    interrupted: true,
    started: 1,
    completed: 0,
    case: `${testClass}#${testMethod}`,
  };
}
