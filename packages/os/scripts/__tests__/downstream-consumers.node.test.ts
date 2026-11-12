import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import manifest from "../downstream-consumers.json" with { type: "json" };

test("every file a downstream product imports by path still exists", () => {
  const missing = manifest.files.filter(
    (file) => !fs.existsSync(new URL(`../../${file}`, import.meta.url)),
  );
  assert.deepEqual(missing, []);
});
