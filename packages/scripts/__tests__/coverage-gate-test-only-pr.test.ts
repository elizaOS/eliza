/** Evaluates the shipped coverage workflow conditions for every changed-test lane. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/coverage-gate.yml", import.meta.url),
);

type Outputs = {
  files: string;
  bun_tests: string;
  vitest_tests: string;
  node_tests: string;
};

/**
 * Extract each named step's single-line `if:` expression. Steps without an
 * `if:` are unconditional; represent that as the literal `true`.
 */
function stepConditions(workflow: string): Map<string, string> {
  const conditions = new Map<string, string>();
  const lines = workflow.split("\n");
  let currentName: string | null = null;
  for (const line of lines) {
    const nameMatch = line.match(/^\s*- name:\s*(.+?)\s*$/);
    if (nameMatch) {
      currentName = nameMatch[1];
      // Default: a step with no `if:` always runs.
      conditions.set(currentName, "true");
      continue;
    }
    const ifMatch = line.match(/^\s*if:\s*(.+?)\s*$/);
    if (ifMatch && currentName) {
      conditions.set(currentName, ifMatch[1]);
    }
  }
  return conditions;
}

/**
 * Evaluate the subset of GitHub-Actions `if:` syntax the coverage-gate lane
 * uses. Recursive-descent over `||` (lowest precedence) then `&&` then atoms,
 * where an atom is `true`, a parenthesized sub-expression, or an
 * `outputs.<id> ==|!= ''` comparison resolved against the scenario.
 */
function evalCondition(expr: string, outputs: Outputs): boolean {
  let pos = 0;
  const src = expr;

  function skipWs() {
    while (pos < src.length && src[pos] === " ") pos++;
  }
  function parseOr(): boolean {
    let value = parseAnd();
    for (;;) {
      skipWs();
      if (src.startsWith("||", pos)) {
        pos += 2;
        // Do not short-circuit: parse the RHS so `pos` advances fully.
        const rhs = parseAnd();
        value = value || rhs;
      } else {
        return value;
      }
    }
  }
  function parseAnd(): boolean {
    let value = parseAtom();
    for (;;) {
      skipWs();
      if (src.startsWith("&&", pos)) {
        pos += 2;
        const rhs = parseAtom();
        value = value && rhs;
      } else {
        return value;
      }
    }
  }
  function parseAtom(): boolean {
    skipWs();
    if (src[pos] === "(") {
      pos++;
      const value = parseOr();
      skipWs();
      if (src[pos] !== ")") {
        throw new Error(`unbalanced parenthesis in: ${expr}`);
      }
      pos++;
      return value;
    }
    if (src.startsWith("true", pos)) {
      pos += 4;
      return true;
    }
    const cmp = src
      .slice(pos)
      .match(/^steps\.changed\.outputs\.(\w+)\s*(==|!=)\s*''/);
    if (!cmp) {
      throw new Error(`unsupported expression at ${pos}: ${expr.slice(pos)}`);
    }
    pos += cmp[0].length;
    const key = cmp[1] as keyof Outputs;
    if (!(key in outputs)) {
      throw new Error(`unknown output '${key}' in: ${expr}`);
    }
    const isEmpty = outputs[key] === "";
    return cmp[2] === "==" ? isEmpty : !isEmpty;
  }

  const result = parseOr();
  skipWs();
  if (pos !== src.length) {
    throw new Error(`trailing tokens in: ${expr.slice(pos)}`);
  }
  return result;
}

const conditions = stepConditions(readFileSync(workflowPath, "utf8"));
const runs = (step: string, outputs: Outputs) => {
  const expr = conditions.get(step);
  if (expr === undefined) {
    throw new Error(`step not found in workflow: ${step}`);
  }
  return evalCondition(expr, outputs);
};

const SETUP = "Setup Bun workspace";
const RUN_BUN = "Run changed Bun tests with coverage";
const RUN_VITEST = "Run changed Vitest tests with coverage";
const RUN_NODE = "Run changed registered Node self-tests";
const GATE = "Apply coverage gate (enforced)";
const REQUIRE_TESTS = "Require changed tests for changed source";

test("self-check: the expression evaluator handles the workflow subset", () => {
  const o = {
    files: "src.ts",
    bun_tests: "",
    vitest_tests: "v.test.ts",
    node_tests: "",
  };
  expect(evalCondition("true", o)).toBe(true);
  expect(evalCondition("steps.changed.outputs.files != ''", o)).toBe(true);
  expect(evalCondition("steps.changed.outputs.bun_tests != ''", o)).toBe(false);
  expect(
    evalCondition(
      "steps.changed.outputs.files != '' && (steps.changed.outputs.bun_tests != '' || steps.changed.outputs.vitest_tests != '')",
      o,
    ),
  ).toBe(true);
});

test("test-only Bun PR executes the changed Bun tests and the gate (#15849)", () => {
  const testOnly: Outputs = {
    files: "",
    bun_tests: "packages/core/src/x.test.ts",
    vitest_tests: "",
    node_tests: "",
  };
  expect(runs(SETUP, testOnly)).toBe(true);
  expect(runs(RUN_BUN, testOnly)).toBe(true);
  expect(runs(GATE, testOnly)).toBe(true);
  // No source changed, so the "require a test" gate must not trip.
  expect(runs(REQUIRE_TESTS, testOnly)).toBe(false);
});

test("test-only Vitest PR executes the changed Vitest tests and the gate (#15849)", () => {
  const testOnly: Outputs = {
    files: "",
    bun_tests: "",
    vitest_tests: "packages/core/src/y.test.ts",
    node_tests: "",
  };
  expect(runs(SETUP, testOnly)).toBe(true);
  expect(runs(RUN_VITEST, testOnly)).toBe(true);
  expect(runs(GATE, testOnly)).toBe(true);
});

test("test-only registered Node PR executes without Bun setup", () => {
  const testOnly: Outputs = {
    files: "",
    bun_tests: "",
    vitest_tests: "",
    node_tests: "scripts/security/coverage-gate.self-test.mjs",
  };
  expect(runs(SETUP, testOnly)).toBe(false);
  expect(runs(RUN_NODE, testOnly)).toBe(true);
  expect(runs(GATE, testOnly)).toBe(true);
  expect(runs(REQUIRE_TESTS, testOnly)).toBe(false);
});

test("docs-only PR (no source, no tests) runs no execution steps", () => {
  const docsOnly: Outputs = {
    files: "",
    bun_tests: "",
    vitest_tests: "",
    node_tests: "",
  };
  expect(runs(SETUP, docsOnly)).toBe(false);
  expect(runs(RUN_BUN, docsOnly)).toBe(false);
  expect(runs(RUN_VITEST, docsOnly)).toBe(false);
  expect(runs(RUN_NODE, docsOnly)).toBe(false);
  expect(runs(GATE, docsOnly)).toBe(false);
  expect(runs(REQUIRE_TESTS, docsOnly)).toBe(false);
});

test("source-with-tests PR runs the matching lane and does not trip the require gate", () => {
  const withTests: Outputs = {
    files: "packages/core/src/a.ts",
    bun_tests: "packages/core/src/a.test.ts",
    vitest_tests: "",
    node_tests: "",
  };
  expect(runs(SETUP, withTests)).toBe(true);
  expect(runs(RUN_BUN, withTests)).toBe(true);
  expect(runs(GATE, withTests)).toBe(true);
  expect(runs(REQUIRE_TESTS, withTests)).toBe(false);
});

test("source-only PR with no changed test still trips the require gate", () => {
  const sourceOnly: Outputs = {
    files: "packages/core/src/a.ts",
    bun_tests: "",
    vitest_tests: "",
    node_tests: "",
  };
  expect(runs(REQUIRE_TESTS, sourceOnly)).toBe(true);
  expect(runs(RUN_BUN, sourceOnly)).toBe(false);
  expect(runs(RUN_VITEST, sourceOnly)).toBe(false);
});
