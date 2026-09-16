/** Verifies that native table markup migrates without changing its attributes. */

import assert from "node:assert/strict";
import test from "node:test";
import { migrateTableMarkup } from "./migrate-raw-tables.mjs";

test("migrates the table family and preserves attributes", () => {
  const source = `/** Fixture. */\nimport React from "react";\nexport const Fixture = () => (\n  <table className="w-full"><thead><tr><th scope="col">Name</th></tr></thead><tbody><tr><td>Ada</td></tr></tbody></table>\n);\n`;
  const migrated = migrateTableMarkup(source, "./table");

  assert.match(
    migrated,
    /import \{ Table, TableBody, TableCell, TableHead, TableHeader, TableRow \} from "\.\/table";/,
  );
  assert.match(migrated, /<Table className="w-full">/);
  assert.match(migrated, /<TableHead scope="col">Name<\/TableHead>/);
  assert.doesNotMatch(migrated, /<\/?(?:table|thead|tbody|tr|th|td)(?:\s|>)/);
});
