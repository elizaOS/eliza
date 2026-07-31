/**
 * Mutates real workflow YAML to prove merge-critical policy regressions fail.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateWorkflowSources } from "./ci-workflow-invariants.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const sources = {
  develop: readFileSync(
    path.join(root, ".github/workflows/develop-pr.yml"),
    "utf8",
  ),
  gitleaks: readFileSync(
    path.join(root, ".github/workflows/gitleaks.yml"),
    "utf8",
  ),
  tests: readFileSync(path.join(root, ".github/workflows/test.yml"), "utf8"),
};

test("accepts the repository workflow graph", () => {
  assert.deepEqual(validateWorkflowSources(sources), { ok: true });
});

for (const fixture of [
  {
    name: "conditional lint",
    key: "develop",
    mutate: (source) =>
      source.replace(
        "      - name: Run lint (read-only)\n",
        "      - name: Run lint (read-only)\n        if: false\n",
      ),
    pattern: /lint:check may not be conditional/,
  },
  {
    name: "permissive gitleaks",
    key: "gitleaks",
    mutate: (source) =>
      source.replace(
        "          gitleaks detect",
        "          gitleaks detect || true",
      ),
    pattern: /success-forcing/,
  },
  {
    name: "missing quality dependency",
    key: "tests",
    mutate: (source) => source.replace("      - merge-quality-gate\n", ""),
    pattern: /ci-ok must need merge-quality-gate/,
  },
  {
    name: "skipped script tests",
    key: "tests",
    mutate: (source) =>
      source.replace("  script-tests:\n", "  script-tests:\n    if: false\n"),
    pattern: /script-tests may not declare if/,
  },
]) {
  test(`rejects ${fixture.name}`, () => {
    const mutated = {
      ...sources,
      [fixture.key]: fixture.mutate(sources[fixture.key]),
    };
    assert.throws(() => validateWorkflowSources(mutated), fixture.pattern);
  });
}
