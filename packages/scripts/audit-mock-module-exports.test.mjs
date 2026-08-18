/**
 * Exercises the mock-export audit against deterministic filesystem fixtures,
 * including missing bindings, explicit suppressions, real-module spreads, and
 * malformed or stale escape hatches without loading repository production code.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  auditMockModuleExports,
  reconcileMockExportBaseline,
} from "./audit-mock-module-exports.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture({ factory, production, directive = "", prelude = "" }) {
  const root = mkdtempSync(path.join(tmpdir(), "mock-export-audit-"));
  roots.push(root);
  const packageRoot = path.join(root, "packages", "fixture");
  mkdirSync(path.join(packageRoot, "src"), { recursive: true });
  writeFileSync(
    path.join(packageRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        paths: { "@fixture/*": ["./src/*"] },
      },
    }),
  );
  writeFileSync(
    path.join(packageRoot, "src", "dependency.ts"),
    "export const bound = 1; export const unbound = 2;\n",
  );
  writeFileSync(path.join(packageRoot, "src", "consumer.ts"), production);
  const testFile = path.join(packageRoot, "src", "consumer.test.ts");
  writeFileSync(
    testFile,
    `import { mock } from "bun:test";\n${prelude}\n${directive}\nmock.module("@fixture/dependency", ${factory});\nawait import("./consumer");\n`,
  );
  const files = [
    testFile,
    path.join(packageRoot, "src", "consumer.ts"),
    path.join(packageRoot, "src", "dependency.ts"),
  ];
  return auditMockModuleExports(root, files);
}

test("reports a named binding omitted by an object factory", () => {
  const report = fixture({
    factory: "() => ({ unbound: 2 })",
    production:
      'import { bound } from "@fixture/dependency"; export { bound };\n',
  });
  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0], /\[missing-export\].*bound/);
});

test("accepts a factory that implements every reachable named binding", () => {
  const report = fixture({
    factory: "() => ({ bound: 7 })",
    production:
      'import { bound } from "@fixture/dependency"; export { bound };\n',
  });
  assert.deepEqual(report.findings, []);
});

test("accepts an explicit, reasoned ignore and rejects stale ignores", () => {
  const ignored = fixture({
    directive:
      "// mock-exports-audit: ignore bound -- this fixture deliberately exercises a partial module",
    factory: "() => ({})",
    production:
      'import { bound } from "@fixture/dependency"; export { bound };\n',
  });
  assert.deepEqual(ignored.findings, []);

  const stale = fixture({
    directive:
      "// mock-exports-audit: ignore unbound -- this suppression no longer has a consumer",
    factory: "() => ({ bound: 7 })",
    production:
      'import { bound } from "@fixture/dependency"; export { bound };\n',
  });
  assert.equal(stale.findings.length, 1);
  assert.match(stale.findings[0], /\[stale-ignore\].*unbound/);
});

test("treats a spread of the real module as complete", () => {
  const report = fixture({
    factory:
      'async () => { const real = await import("@fixture/dependency"); return { ...real, bound: 9 }; }',
    production:
      'import { bound, unbound } from "@fixture/dependency"; export { bound, unbound };\n',
  });
  assert.deepEqual(report.findings, []);
});

test("treats a statically imported real namespace spread as complete", () => {
  const report = fixture({
    prelude: 'import * as realDependency from "@fixture/dependency";',
    factory: "() => ({ ...realDependency, bound: 9 })",
    production:
      'import { bound, unbound } from "@fixture/dependency"; export { bound, unbound };\n',
  });
  assert.deepEqual(report.findings, []);
});

test("fails closed for an unanalyzable whole-module factory", () => {
  const report = fixture({
    factory: "() => new Proxy({}, {})",
    production:
      'import { bound } from "@fixture/dependency"; export { bound };\n',
  });
  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0], /\[unsupported-factory\].*bound/);
});

test("requires ignores to carry a durable reason", () => {
  const report = fixture({
    directive: "// mock-exports-audit: ignore bound",
    factory: "() => ({})",
    production:
      'import { bound } from "@fixture/dependency"; export { bound };\n',
  });
  assert.equal(report.findings.length, 2);
  assert.match(report.findings.join("\n"), /\[invalid-ignore\]/);
  assert.match(report.findings.join("\n"), /\[missing-export\]/);
});

test("ratchets known debt and rejects both new and stale baseline counts", () => {
  const findings = [
    '[missing-export] packages/example.test.ts:20 mock "./real" is missing bound export(s): value',
  ];
  const baseline = [
    {
      finding:
        '[missing-export] packages/example.test.ts mock "./real" is missing bound export(s): value',
      count: 1,
    },
  ];
  assert.deepEqual(reconcileMockExportBaseline(findings, baseline), []);
  assert.match(
    reconcileMockExportBaseline([...findings, ...findings], baseline)[0],
    /\[new-finding\].*above baseline/,
  );
  assert.match(
    reconcileMockExportBaseline([], baseline)[0],
    /\[stale-baseline\].*no longer reproduced/,
  );
});
