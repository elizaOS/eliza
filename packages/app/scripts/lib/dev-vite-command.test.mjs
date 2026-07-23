/**
 * Verifies app development entrypoints share one Node-backed Vite command,
 * including dashboard flags and fail-fast dependency diagnostics.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveViteCommand } from "../../../app-core/scripts/lib/dev-ui-vite.mjs";

const appDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const repoRoot = path.resolve(appDir, "../..");
const viteCli = path.join(appDir, "node_modules", "vite", "bin", "vite.js");
const appPackage = JSON.parse(
  readFileSync(path.join(appDir, "package.json"), "utf8"),
);

describe("development Vite process commands", () => {
  it("runs the shared server through Node with source import support", () => {
    assert.deepEqual(
      resolveViteCommand({ appDir, nodePath: "/usr/local/bin/node" }),
      {
        command: "/usr/local/bin/node",
        args: ["--import", "tsx", viteCli],
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
        args: ["--import", "tsx", viteCli, "--force", "--port", "2138"],
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
        args: ["--import", "tsx", viteCli, "--port", "2138"],
      },
    );
  });

  it("keeps direct package dev commands on Node with source import support", () => {
    assert.equal(
      appPackage.scripts.dev,
      "node --import tsx ./node_modules/vite/bin/vite.js",
    );
    assert.equal(
      appPackage.scripts["dev:chat-harness"],
      "ELIZA_CHAT_UI_HARNESS=1 node --import tsx ./node_modules/vite/bin/vite.js",
    );
  });

  it("loads source-conditioned NodeNext workspace packages", () => {
    const viteCommand = resolveViteCommand({
      appDir,
      nodePath: "node",
    });
    const result = spawnSync(
      viteCommand.command,
      [
        "--conditions=eliza-source",
        ...viteCommand.args.slice(0, 2),
        "--input-type=module",
        "--eval",
        'await import("@elizaos/cloud-routing")',
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
