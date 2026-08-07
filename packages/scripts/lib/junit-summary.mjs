/**
 * Parses bounded Bun and Vitest JUnit evidence and reconciles every declared
 * count with the testcase tree before CI treats a selection as real work.
 */

import { SaxesParser } from "saxes";

export const MAX_JUNIT_BYTES = 16 * 1024 * 1024;
const MAX_JUNIT_DEPTH = 64;
const MAX_JUNIT_TESTCASES = 1_000_000;
const ALLOWED_CHILDREN = new Map([
  [undefined, new Set(["testsuites"])],
  ["testsuites", new Set(["testsuite"])],
  [
    "testsuite",
    new Set([
      "testsuite",
      "testcase",
      "properties",
      "system-out",
      "system-err",
    ]),
  ],
  ["properties", new Set(["property"])],
  ["property", new Set()],
  [
    "testcase",
    new Set(["failure", "error", "skipped", "system-out", "system-err"]),
  ],
  ["failure", new Set()],
  ["error", new Set()],
  ["skipped", new Set()],
  ["system-out", new Set()],
  ["system-err", new Set()],
]);
const TEXT_BEARING_ELEMENTS = new Set([
  "failure",
  "error",
  "skipped",
  "system-out",
  "system-err",
]);
const COUNT_NAMES = ["tests", "failures", "errors", "skipped"];

function emptyCounts() {
  return { tests: 0, failures: 0, errors: 0, skipped: 0 };
}

function addCounts(target, source) {
  for (const name of COUNT_NAMES) target[name] += source[name];
}

function declaredCount(attributes, name, label) {
  const raw = attributes[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`JUnit ${label} has no valid ${name} count`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`JUnit ${label} has no safe ${name} count`);
  }
  return value;
}

function reconcileDeclaredCounts(node, label, allowOmittedNonzero = new Set()) {
  for (const name of COUNT_NAMES) {
    const declared = declaredCount(node.attributes, name, label);
    if (declared === undefined) {
      if (node.counts[name] !== 0 && !allowOmittedNonzero.has(name)) {
        throw new Error(
          `JUnit ${label} omits ${name} but contains ${node.counts[name]}`,
        );
      }
      continue;
    }
    if (declared !== node.counts[name]) {
      throw new Error(
        `JUnit ${label} ${name}=${declared} does not match nested ${name}=${node.counts[name]}`,
      );
    }
  }
}

/** Parse one bounded JUnit artifact and return reconciled semantic counts. */
export function parseJunitSummary(xml) {
  if (typeof xml !== "string" || !xml.trim()) {
    throw new Error("JUnit artifact is empty");
  }
  if (Buffer.byteLength(xml, "utf8") > MAX_JUNIT_BYTES) {
    throw new Error(`JUnit artifact exceeds ${MAX_JUNIT_BYTES} bytes`);
  }

  const parser = new SaxesParser({ xmlns: false });
  const stack = [];
  let root;
  let testcaseCount = 0;

  parser.on("doctype", () => {
    throw new Error("JUnit artifact may not contain a DOCTYPE");
  });
  parser.on("processinginstruction", () => {
    throw new Error("JUnit artifact may not contain processing instructions");
  });
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1);
    if (!ALLOWED_CHILDREN.get(parent?.name)?.has(tag.name)) {
      throw new Error(
        `JUnit artifact contains <${tag.name}> under <${parent?.name ?? "document"}>`,
      );
    }
    if (stack.length >= MAX_JUNIT_DEPTH) {
      throw new Error(
        `JUnit artifact exceeds nesting depth ${MAX_JUNIT_DEPTH}`,
      );
    }
    if (tag.name === "testsuites" && root !== undefined) {
      throw new Error("JUnit artifact must contain one testsuites root");
    }
    if (tag.name === "testcase") {
      testcaseCount += 1;
      if (testcaseCount > MAX_JUNIT_TESTCASES) {
        throw new Error(
          `JUnit artifact exceeds ${MAX_JUNIT_TESTCASES} testcases`,
        );
      }
    }
    const node = {
      name: tag.name,
      attributes: tag.attributes,
      counts: emptyCounts(),
      testcaseResult: undefined,
    };
    if (tag.name === "testsuites") root = node;
    if (
      parent?.name === "testcase" &&
      ["failure", "error", "skipped"].includes(tag.name)
    ) {
      if (parent.testcaseResult !== undefined) {
        throw new Error(
          "JUnit testcase may contain at most one failure, error, or skipped result",
        );
      }
      parent.testcaseResult = tag.name;
    }
    stack.push(node);
  });
  parser.on("closetag", () => {
    const node = stack.pop();
    const parent = stack.at(-1);
    if (!node) {
      throw new Error("JUnit artifact closes an element that was not opened");
    }
    if (node.name === "testcase") {
      node.counts.tests = 1;
      if (node.testcaseResult === "failure") node.counts.failures = 1;
      if (node.testcaseResult === "error") node.counts.errors = 1;
      if (node.testcaseResult === "skipped") node.counts.skipped = 1;
    } else if (node.name === "testsuite" || node.name === "testsuites") {
      reconcileDeclaredCounts(
        node,
        node.name === "testsuites"
          ? "root"
          : `testsuite ${node.attributes.name ?? "<unnamed>"}`,
        // Vitest omits these root counts even when child suites report them.
        node.name === "testsuites" ? new Set(["errors", "skipped"]) : undefined,
      );
    }
    if (parent && (node.name === "testcase" || node.name === "testsuite")) {
      addCounts(parent.counts, node.counts);
    }
  });
  parser.on("text", (value) => {
    if (value.trim() && !TEXT_BEARING_ELEMENTS.has(stack.at(-1)?.name)) {
      throw new Error("JUnit artifact contains unexpected text content");
    }
  });
  parser.on("cdata", (value) => {
    if (value.trim() && !TEXT_BEARING_ELEMENTS.has(stack.at(-1)?.name)) {
      throw new Error("JUnit artifact contains unexpected CDATA content");
    }
  });

  parser.write(xml).close();
  if (root?.name !== "testsuites" || stack.length !== 0) {
    throw new Error("JUnit artifact must contain one complete testsuites root");
  }
  return {
    ...root.counts,
    executedTests: root.counts.tests - root.counts.skipped,
  };
}
