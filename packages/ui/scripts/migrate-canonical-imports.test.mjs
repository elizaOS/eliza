/** Tests the canonical import migration in dry-run mode against real sources. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { destination, migrateImports } from "./migrate-canonical-imports.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

test("the migration reports every remaining deep import without writing", () => {
  const output = execFileSync(
    process.execPath,
    [path.join(scriptDir, "migrate-canonical-imports.mjs")],
    { encoding: "utf8" },
  );
  assert.match(output, /^Would migrate 0 files/m);
});

test("the migration changes import declarations without changing compatibility strings", () => {
  const source = `
import { Select } from "@elizaos/ui/components/ui/select";

const compatibilityModules = {
  "@elizaos/ui/components/ui/select": () => import("./select.tsx"),
};
`;

  assert.equal(
    migrateImports("fixture.ts", source),
    source.replace(
      'import { Select } from "@elizaos/ui/components/ui/select";',
      'import { Select } from "@elizaos/ui";',
    ),
  );
});

test("the migration rewrites re-export declarations, not just imports", () => {
  const source = [
    'export { Button } from "@elizaos/ui/components/ui/button";',
    'export { CompactCardSkeleton } from "@elizaos/ui/components/ui/skeleton-layouts";',
    'export * from "@elizaos/ui/components/ui/spinner";',
    "",
  ].join("\n");

  assert.equal(
    migrateImports("fixture.ts", source),
    [
      'export { Button } from "@elizaos/ui/button";',
      'export { CompactCardSkeleton } from "@elizaos/ui";',
      'export * from "@elizaos/ui";',
      "",
    ].join("\n"),
  );
});

test("the migration leaves export declarations without a module specifier alone", () => {
  const source = "const Button = 1;\nexport { Button };\n";
  assert.equal(migrateImports("fixture.ts", source), source);
});

test("the migration preserves dedicated public atom exports", () => {
  assert.equal(
    destination("@elizaos/ui/components/ui/button"),
    "@elizaos/ui/button",
  );
  assert.equal(destination("@elizaos/ui/components/ui/select"), "@elizaos/ui");
});

test("plugin views use the host-rewritable root export", () => {
  const file = path.resolve(scriptDir, "../../../plugins/example/view.tsx");
  const source = 'import { Button } from "@elizaos/ui/button";\n';

  assert.equal(
    migrateImports(file, source),
    'import { Button } from "@elizaos/ui";\n',
  );
});
