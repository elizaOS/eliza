/**
 * Verifies anti-larp discovery and parsing cannot turn empty, unreadable, or
 * platform-shaped test inventories into a clean result.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverTestSourceFiles,
  findViolations,
  parseFocusedAuditArgs,
  readTestSources,
} from "../audit-focused-skipped-tests.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "focused-audit-"));
  tempDirs.push(dir);
  return dir;
}

describe("anti-larp test discovery", () => {
  test("covers supported extensions and nesting with canonical Git paths", () => {
    expect(
      discoverTestSourceFiles("/unused", [
        "plugins/one/src/nested/component.SPEC.CTS",
        "packages/two/tests/helper.MJS",
        "packages/three/src/feed.e2e.test.tsx",
        "packages/three/src/production.ts",
        "packages/four/src/native.test.rs",
      ]),
    ).toEqual([
      "packages/three/src/feed.e2e.test.tsx",
      "packages/two/tests/helper.MJS",
      "plugins/one/src/nested/component.SPEC.CTS",
    ]);
    expect(() =>
      discoverTestSourceFiles("/unused", [
        "plugins\\one\\src\\nested\\component.SPEC.CTS",
      ]),
    ).toThrow("backslash");
  });

  test("rejects empty and case-colliding inventories", () => {
    expect(() => discoverTestSourceFiles("/unused", [])).toThrow(
      /zero JavaScript test sources/,
    );
    expect(() =>
      discoverTestSourceFiles("/unused", [
        "pkg/src/example.test.ts",
        "PKG/src/EXAMPLE.TEST.TS",
      ]),
    ).toThrow(/case-colliding or duplicate test source paths/);
  });

  test("requires exact, reasoned, non-stale source exclusions", () => {
    const fixture = "pkg/src/example.test.ts";
    expect(
      discoverTestSourceFiles(
        "/unused",
        [fixture, "pkg/src/other.test.ts"],
        new Map([[fixture, "deliberately invalid parser fixture"]]),
      ),
    ).toEqual(["pkg/src/other.test.ts"]);
    expect(() =>
      discoverTestSourceFiles(
        "/unused",
        [fixture],
        new Map([["pkg/src/deleted.test.ts", "durable deleted reason"]]),
      ),
    ).toThrow("stale test-source exclusion");
    expect(() =>
      discoverTestSourceFiles(
        "/unused",
        [fixture],
        new Map([[fixture, "short"]]),
      ),
    ).toThrow("durable reason");
  });

  test("surfaces a discovered source that cannot be read", () => {
    expect(() => readTestSources(["missing.test.ts"], tempDir())).toThrow();
  });

  test("rejects a discovered source or ancestor reached through a symlink", () => {
    const root = tempDir();
    const outside = tempDir();
    fs.writeFileSync(
      path.join(outside, "linked.test.ts"),
      'test.only("hidden", () => {});\n',
    );
    fs.symlinkSync(outside, path.join(root, "linked"));
    expect(() => readTestSources(["linked/linked.test.ts"], root)).toThrow(
      "may not traverse a symlink",
    );
  });

  test("returns every discovered source without hiding parse syntax", () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "one.test.ts"), 'test("one", () => {});');
    expect(readTestSources(["one.test.ts"], root)).toEqual([
      {
        rel: "one.test.ts",
        content: 'test("one", () => {});',
      },
    ]);
    expect(() => findViolations("broken.test.ts", "test(")).toThrow(
      /could not be parsed/,
    );
  });

  test("the AST catches split, chained, and computed focus without strings", () => {
    const source = `
      const documentation = "test.only(";
      test.describe
        ["only"]("focused", () => {});
      it.skip("requires a live database", () => {});
    `;
    expect(findViolations("fixture.test.ts", source)).toEqual([
      expect.objectContaining({ kind: "focused", line: 3 }),
    ]);
  });

  test("rejects undocumented permanent and malformed conditional disables", () => {
    const source = `
      it.skipIf(true)("permanently off", () => {});
      test.skip();
      test.skip(isUnavailable);
      test.fixme("ordinary title", () => {});
      it.skip("badge renders disabled state", () => {
        expect(label).toBe("disabled");
      });
    `;
    expect(
      findViolations("fixture.test.ts", source).map(({ kind }) => kind),
    ).toEqual([
      "orphaned-skip",
      "orphaned-skip",
      "orphaned-skip",
      "orphaned-skip",
      "orphaned-skip",
    ]);
  });

  test("accepts documented permanent and conditional disables", () => {
    const source = `
      // No model bundle is loaded in this test lane.
      it.skipIf(true)("real model path", () => {});
      test.skip(!healthy, "Server is not healthy");
      test.fixme(needsBrowser, "Browser backend is unavailable");
      test.skip("requires a live database", () => {});
    `;
    expect(findViolations("fixture.test.ts", source)).toEqual([]);
  });

  test("resolves imported, namespace, assigned, and destructured runner aliases", () => {
    const source = `
      import { test as check } from "bun:test";
      import * as runner from "vitest";
      import nodeTest from "node:test";
      const focus = check.only;
      const { only: focusedCheck, skip: skippedCheck } = check;
      focus("assigned focus", () => {});
      focusedCheck("destructured focus", () => {});
      runner.describe.only("namespace focus", () => {});
      nodeTest("node option focus", { only: true }, () => {});
      check("node option skip", { skip: true }, () => {});
      skippedCheck("destructured skip", () => {});
      check.skipIf("truthy")("truthy conditional", () => {});
    `;
    expect(
      findViolations("fixture.test.ts", source).map(({ kind }) => kind),
    ).toEqual([
      "focused",
      "focused",
      "focused",
      "focused",
      "orphaned-skip",
      "orphaned-skip",
      "orphaned-skip",
    ]);
  });

  test("evaluates static truthy disables and accepts false or reasoned options", () => {
    const source = `
      import { test } from "vitest";
      test.skipIf(1)("ordinary title", () => {});
      test.todoIf(Boolean("yes"))("another title", () => {});
      const permanentlySkipped = test.skipIf("truthy");
      permanentlySkipped("aliased title", () => {});
      test.skipIf(0)("runs", () => {});
      test.todoIf(false)("runs", () => {});
      test("live path", { skip: "requires a live service" }, () => {});
    `;
    expect(
      findViolations("fixture.test.ts", source).map(({ kind }) => kind),
    ).toEqual(["orphaned-skip", "orphaned-skip", "orphaned-skip"]);
  });

  test("does not treat shadowed or unrelated runner-shaped names as test APIs", () => {
    const source = `
      import { test as importedTest } from "bun:test";
      import { test } from "custom-library";
      function receives(importedTest) {
        importedTest.only("not a runner", () => {});
      }
      function localScope() {
        const importedTest = customRunner;
        importedTest.only("not a runner", () => {});
      }
      test.only("custom import", () => {});
    `;
    expect(findViolations("fixture.test.ts", source)).toEqual([]);
  });

  test("rejects ignored or conflicting CLI input", () => {
    expect(parseFocusedAuditArgs(["--dry-run"])).toEqual({
      dryRun: true,
      help: false,
      json: false,
      selfTest: false,
    });
    expect(() => parseFocusedAuditArgs(["--dri-run"])).toThrow(
      /unknown argument/,
    );
    expect(() => parseFocusedAuditArgs(["--self-test", "--dry-run"])).toThrow(
      /cannot be combined/,
    );
    expect(() => parseFocusedAuditArgs(["--json", "--json"])).toThrow(
      /only once/,
    );
    expect(() => parseFocusedAuditArgs(["--help", "--json"])).toThrow(
      /cannot be combined/,
    );
  });
});
