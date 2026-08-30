/** Verifies the development Vite subprocess resolves source TypeScript config imports. */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import {
  resolveSupervisedViteCommand,
  resolveViteCommand,
} from "./dev-ui-vite.mjs";

const appDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../app",
);

test("resolveViteCommand keeps the Vite 8 config and React plugin on one loader", () => {
  const resolved = resolveViteCommand({
    appDir,
    runtime: "node",
    runtimePath: "/test/runtime",
    port: 2138,
  });

  expect(resolved.command).toBe("/test/runtime");
  expect(resolved.args).toEqual([
    "--conditions=eliza-source",
    "--import",
    "tsx",
    path.join(appDir, "node_modules", "vite", "bin", "vite.js"),
    "--configLoader",
    "bundle",
    "--port",
    "2138",
  ]);
});

test("resolveViteCommand stays Bun-backed when its caller runs under Bun", () => {
  const helperUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "dev-ui-vite.mjs"),
  ).href;
  const script = `
    import { resolveViteCommand } from ${JSON.stringify(helperUrl)};
    const resolved = resolveViteCommand({ appDir: ${JSON.stringify(appDir)} });
    process.stdout.write(JSON.stringify(resolved));
  `;
  const resolution = spawnSync("bun", ["--eval", script], {
    encoding: "utf8",
    env: { ...process.env, ELIZA_NODE_PATH: "" },
  });

  expect(resolution.status, resolution.stderr).toBe(0);
  const resolved = JSON.parse(resolution.stdout);
  expect(resolved.args).not.toContain("tsx");
  const runtimePath = resolved.command;
  const runtime = spawnSync(
    runtimePath,
    [
      "--eval",
      "process.stdout.write(process.versions.bun ? 'bun' : 'node:' + process.versions.node)",
    ],
    { encoding: "utf8" },
  );
  expect(runtime.status, runtime.stderr).toBe(0);
  expect(runtime.stdout).toBe("bun");
});

test("resolveSupervisedViteCommand keeps the HTTP proxy on Node", () => {
  const resolved = resolveSupervisedViteCommand({
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
    "bundle",
    "--port",
    "2138",
  ]);
});
