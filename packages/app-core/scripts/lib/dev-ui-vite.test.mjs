/** Verifies the development Vite subprocess resolves source TypeScript config imports. */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
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

function resolveBunExecutable() {
  if (process.versions.bun) return process.execPath;
  const probe = spawnSync(
    "bun",
    ["--eval", "process.stdout.write(process.execPath)"],
    { encoding: "utf8" },
  );
  expect(probe.status, probe.stderr).toBe(0);
  return probe.stdout.trim();
}

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

test("Vite resolution succeeds with a PATH that contains Bun and no Node executable", () => {
  const binDir = mkdtempSync(path.join(os.tmpdir(), "eliza-bun-only-path-"));
  const bunName = process.platform === "win32" ? "bun.exe" : "bun";
  const bunPath = path.join(binDir, bunName);
  try {
    symlinkSync(resolveBunExecutable(), bunPath);
    const helperUrl = pathToFileURL(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "dev-ui-vite.mjs",
      ),
    ).href;
    const script = `
      import { resolveViteCommand } from ${JSON.stringify(helperUrl)};
      const resolved = resolveViteCommand({ appDir: ${JSON.stringify(appDir)} });
      process.stdout.write(JSON.stringify(resolved));
    `;
    const result = spawnSync(bunPath, ["--eval", script], {
      encoding: "utf8",
      env: { PATH: binDir, ELIZA_NODE_PATH: "" },
    });
    expect(result.status, result.stderr).toBe(0);
    const resolved = JSON.parse(result.stdout);
    expect(path.basename(resolved.command)).toBe("bun");
    expect(resolved.args).not.toContain("tsx");
    const nodeProbe = spawnSync("node", ["--version"], {
      encoding: "utf8",
      env: { PATH: binDir },
    });
    expect(nodeProbe.status).not.toBe(0);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("resolveSupervisedViteCommand pins the supervised child to a Node 24+ runtime", () => {
  // The supervisor may run under Bun; the Vite proxy child must still be Node so
  // its `/api` and `/ws` proxy does not crash on `socket.destroySoon`.
  const resolveNodePath = ({ currentExecPath, platform, explicitNodePath }) => {
    expect(currentExecPath).toBe("/usr/local/bin/bun");
    expect(platform).toBe("linux");
    expect(explicitNodePath).toBeUndefined();
    return "/opt/node24/bin/node";
  };

  const resolved = resolveSupervisedViteCommand({
    appDir,
    port: 2138,
    currentExecPath: "/usr/local/bin/bun",
    platform: "linux",
    explicitNodePath: "  ",
    resolveNodePath,
  });

  expect(resolved.command).toBe("/opt/node24/bin/node");
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

test("resolveSupervisedViteCommand honors force and forwards the ELIZA_NODE_PATH override", () => {
  const resolveNodePath = ({ explicitNodePath }) => {
    expect(explicitNodePath).toBe("/custom/node");
    return "/custom/node";
  };

  const resolved = resolveSupervisedViteCommand({
    appDir,
    force: true,
    port: 4000,
    explicitNodePath: "/custom/node",
    resolveNodePath,
    viteArgs: ["--host", "127.0.0.1"],
  });

  expect(resolved.command).toBe("/custom/node");
  expect(resolved.args).toContain("--import");
  expect(resolved.args).toContain("tsx");
  expect(resolved.args).toContain("--force");
  expect(resolved.args.slice(-4)).toEqual([
    "--port",
    "4000",
    "--host",
    "127.0.0.1",
  ]);
});

test("resolveSupervisedViteCommand surfaces an actionable error when no Node 24+ runtime resolves", () => {
  const resolveNodePath = () => {
    throw new Error(
      "No usable Node.js 24+ executable found. Install Node.js 24+ or set ELIZA_NODE_PATH=/absolute/path/to/node.",
    );
  };

  expect(() =>
    resolveSupervisedViteCommand({ appDir, port: 2138, resolveNodePath }),
  ).toThrow(/No usable Node\.js 24\+ executable found/);
});

test("the supervised command diverges from the Bun-backed generic default", () => {
  // Reverting the supervised runtime pin would fall back to resolveViteCommand's
  // generic default, which stays Bun-backed under a Bun orchestrator (no tsx
  // import). The supervised command must instead force the Node arg contract.
  const bunBacked = resolveViteCommand({
    appDir,
    runtime: "bun",
    runtimePath: "/usr/local/bin/bun",
    port: 2138,
  });
  expect(bunBacked.command).toBe("/usr/local/bin/bun");
  expect(bunBacked.args).not.toContain("tsx");

  const supervised = resolveSupervisedViteCommand({
    appDir,
    port: 2138,
    currentExecPath: "/usr/local/bin/bun",
    platform: "linux",
    resolveNodePath: () => "/opt/node24/bin/node",
  });
  expect(supervised.command).toBe("/opt/node24/bin/node");
  expect(supervised.args).toContain("tsx");
});
