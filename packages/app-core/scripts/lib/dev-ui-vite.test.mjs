/** Verifies the development Vite subprocess resolves source TypeScript config imports. */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { resolveViteCommand } from "./dev-ui-vite.mjs";

const appDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../app",
);

test("resolveViteCommand uses the source-aware runner config loader", () => {
  const resolved = resolveViteCommand({
    appDir,
    nodePath: "/test/node",
    port: 2138,
  });

  expect(resolved.command).toBe("/test/node");
  expect(resolved.args).toEqual([
    "--conditions=eliza-source",
    "--import",
    "tsx",
    path.join(appDir, "node_modules", "vite", "bin", "vite.js"),
    "--configLoader",
    "runner",
    "--port",
    "2138",
  ]);
});

test("resolveViteCommand stays Node-backed when its caller runs under Bun", () => {
  const helperUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "dev-ui-vite.mjs"),
  ).href;
  const script = `
    import { resolveViteCommand } from ${JSON.stringify(helperUrl)};
    const resolved = resolveViteCommand({ appDir: ${JSON.stringify(appDir)} });
    process.stdout.write(resolved.command);
  `;
  const resolution = spawnSync("bun", ["--eval", script], {
    encoding: "utf8",
    env: { ...process.env, ELIZA_NODE_PATH: "" },
  });

  expect(resolution.status, resolution.stderr).toBe(0);
  const nodePath = resolution.stdout.trim();
  const runtime = spawnSync(
    nodePath,
    [
      "--eval",
      "process.stdout.write(process.versions.bun ? 'bun' : 'node:' + process.versions.node)",
    ],
    { encoding: "utf8" },
  );
  expect(runtime.status, runtime.stderr).toBe(0);
  expect(runtime.stdout).toMatch(/^node:24\./);
});
