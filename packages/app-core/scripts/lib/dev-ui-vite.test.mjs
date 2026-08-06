/** Verifies the development Vite subprocess uses the direct TypeScript config loader. */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveViteCommand } from "./dev-ui-vite.mjs";

const appDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../app",
);

test("resolveViteCommand skips Vite's redundant config bundling", () => {
  const resolved = resolveViteCommand({
    appDir,
    nodePath: "/test/node",
    port: 2138,
  });

  assert.equal(resolved.command, "/test/node");
  assert.deepEqual(resolved.args.slice(-4), [
    "--configLoader",
    "native",
    "--port",
    "2138",
  ]);
});
