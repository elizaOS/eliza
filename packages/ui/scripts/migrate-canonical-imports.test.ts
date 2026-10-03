/** Exercises canonical import rewriting while preserving compatibility strings and public entry points. */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { destination, migrateImports } from "./migrate-canonical-imports.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

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
