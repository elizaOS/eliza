// Source-level smoke: avoid importing the React tree; static-check that the
// App entry exports an `App` function component. Runs under `node --test` so
// the package `test` script exits clean without pulling vitest as a dep.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(__dirname, "../src/App.tsx");

test("App.tsx exports an App function component", () => {
  const src = readFileSync(appPath, "utf8");
  assert.match(
    src,
    /export\s+function\s+App\s*\(/,
    "expected `export function App(...)` in App.tsx",
  );
});
