/** The build gate reads actual module syntax, including import-type nodes. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findCrossPackageImports } from "../../agent/scripts/assert-package-boundary-imports.ts";

test("rejects escaped syntax imports without interpreting comments or string contents", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-boundary-"));
  try {
    mkdirSync(path.join(directory, "src"));
    writeFileSync(
      path.join(directory, "src/entry.ts"),
      [
        '// import "../../comment.ts";',
        'const text = `import "../../string.ts"`;',
        'const delimiters = "/*";',
        'export type Outside = import("../../outside.ts").Outside;',
        'export { value } from "../../sibling.ts";',
        "await import(`../../dynamic.ts`);",
        'import "./local.ts";',
      ].join("\n"),
    );
    writeFileSync(
      path.join(directory, "src/fixture.test.ts"),
      'import "../../test-only.ts";',
    );
    expect(findCrossPackageImports(directory)).toEqual([
      { file: "src/entry.ts", line: 4, specifier: "../../outside.ts" },
      { file: "src/entry.ts", line: 5, specifier: "../../sibling.ts" },
      { file: "src/entry.ts", line: 6, specifier: "../../dynamic.ts" },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
