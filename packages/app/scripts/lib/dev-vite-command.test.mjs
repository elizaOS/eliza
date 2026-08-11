/**
 * Verifies app development entrypoints share one Node-backed Vite command,
 * including dashboard flags, child lifecycle, and dependency diagnostics.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveViteCommand } from "../../../app-core/scripts/lib/dev-ui-vite.mjs";

const appDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const repoRoot = path.resolve(appDir, "../..");
const viteCli = path.join(appDir, "node_modules", "vite", "bin", "vite.js");
const mirroredChildUrl = pathToFileURL(
  path.join(appDir, "scripts", "lib", "spawn-mirrored-child.mjs"),
).href;
const appPackage = JSON.parse(
  readFileSync(path.join(appDir, "package.json"), "utf8"),
);

async function runMirroredChildProbe({ childSource, wrapperSignal }) {
  const wrapperSource = `
    import { spawnMirroredChild } from ${JSON.stringify(mirroredChildUrl)};
    const child = spawnMirroredChild(
      process.execPath,
      ["--input-type=module", "--eval", ${JSON.stringify(childSource)}],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    child.stdout.pipe(process.stdout);
  `;
  const wrapper = spawn(
    process.execPath,
    ["--input-type=module", "--eval", wrapperSource],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let ready;
  const readyPromise = new Promise((resolve) => {
    ready = resolve;
  });
  wrapper.stdout.setEncoding("utf8");
  wrapper.stderr.setEncoding("utf8");
  wrapper.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("ready\n")) ready();
  });
  wrapper.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitPromise = new Promise((resolve, reject) => {
    wrapper.once("error", reject);
    wrapper.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      if (wrapper.exitCode === null && wrapper.signalCode === null) {
        wrapper.kill("SIGTERM");
      }
      reject(
        new Error(
          `mirrored child probe timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, 5_000);
  });

  try {
    if (wrapperSignal) {
      await Promise.race([
        readyPromise,
        exitPromise.then(({ code, signal }) => {
          throw new Error(
            `probe exited before ready: code=${code} signal=${signal}\n${stderr}`,
          );
        }),
        timeoutPromise,
      ]);
      wrapper.kill(wrapperSignal);
    }
    return {
      ...(await Promise.race([exitPromise, timeoutPromise])),
      stderr,
      stdout,
    };
  } finally {
    clearTimeout(timeout);
  }
}

describe("development Vite process commands", () => {
  it("runs the shared server through Node with source import support", () => {
    assert.deepEqual(
      resolveViteCommand({ appDir, nodePath: "/usr/local/bin/node" }),
      {
        command: "/usr/local/bin/node",
        args: [
          "--conditions=eliza-source",
          "--import",
          "tsx",
          viteCli,
          "--configLoader",
          "native",
        ],
      },
    );
  });

  it("preserves dashboard force and port flags", () => {
    assert.deepEqual(
      resolveViteCommand({
        appDir,
        force: true,
        nodePath: "/usr/bin/node",
        port: 2138,
      }),
      {
        command: "/usr/bin/node",
        args: [
          "--conditions=eliza-source",
          "--import",
          "tsx",
          viteCli,
          "--configLoader",
          "native",
          "--force",
          "--port",
          "2138",
        ],
      },
    );
    assert.deepEqual(
      resolveViteCommand({
        appDir,
        nodePath: "/usr/bin/node",
        port: 2138,
      }),
      {
        command: "/usr/bin/node",
        args: [
          "--conditions=eliza-source",
          "--import",
          "tsx",
          viteCli,
          "--configLoader",
          "native",
          "--port",
          "2138",
        ],
      },
    );
  });

  it("forwards direct Vite CLI flags after the canonical dev arguments", () => {
    const resolved = resolveViteCommand({
      appDir,
      nodePath: "/usr/bin/node",
      viteArgs: ["--host", "127.0.0.1"],
    });

    assert.deepEqual(resolved.args.slice(-2), ["--host", "127.0.0.1"]);
  });

  it("keeps direct package dev commands on Node with source import support", () => {
    assert.equal(appPackage.scripts.dev, "node scripts/dev.mjs");
    assert.equal(
      appPackage.scripts["dev:chat-harness"],
      "ELIZA_CHAT_UI_HARNESS=1 node scripts/dev.mjs",
    );
    const directDevSource = readFileSync(
      path.join(appDir, "scripts", "dev.mjs"),
      "utf8",
    );
    assert.match(directDevSource, /resolveViteCommand\(\{/);
    assert.match(directDevSource, /viteArgs: process\.argv\.slice\(2\)/);
    assert.match(directDevSource, /spawnMirroredChild\(/);
  });

  for (const exitCode of [0, 23]) {
    it(`preserves ordinary child exit code ${exitCode}`, async () => {
      const result = await runMirroredChildProbe({
        childSource: `process.exit(${exitCode})`,
      });

      assert.deepEqual(
        { code: result.code, signal: result.signal },
        { code: exitCode, signal: null },
        result.stderr,
      );
    });
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    it(`preserves ${signal} as a signal termination`, {
      skip: process.platform === "win32",
    }, async () => {
      const result = await runMirroredChildProbe({
        childSource:
          'process.stdout.write("ready\\n"); setInterval(() => {}, 1_000)',
        wrapperSignal: signal,
      });

      assert.deepEqual(
        { code: result.code, signal: result.signal },
        { code: null, signal },
        `${result.stderr}\n${result.stdout}`,
      );
    });
  }

  it("loads NodeNext workspace source with the production child argv", () => {
    const viteCommand = resolveViteCommand({
      appDir,
      nodePath: "node",
    });
    const viteCliIndex = viteCommand.args.indexOf(viteCli);
    assert.notEqual(viteCliIndex, -1);
    const result = spawnSync(
      viteCommand.command,
      [
        ...viteCommand.args.slice(0, viteCliIndex),
        "--input-type=module",
        "--eval",
        'await import("./packages/core/src/cloud-routing.ts")',
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
  });

  it("fails before spawning when Node or the Vite CLI is unavailable", () => {
    assert.throws(
      () => resolveViteCommand({ appDir, nodePath: null }),
      /Node.js is required/,
    );
    assert.throws(
      () =>
        resolveViteCommand({
          appDir: path.join(appDir, "missing"),
          nodePath: "/usr/bin/node",
        }),
      /Vite CLI not found/,
    );
  });
});
