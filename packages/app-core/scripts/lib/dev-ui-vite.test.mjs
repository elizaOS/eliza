/** Verifies the development Vite subprocess uses the direct TypeScript config loader. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
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

  expect(resolved.command).toBe("/test/node");
  expect(resolved.args.slice(-4)).toEqual([
    "--configLoader",
    "native",
    "--port",
    "2138",
  ]);
});
