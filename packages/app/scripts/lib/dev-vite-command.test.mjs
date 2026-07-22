/**
 * Verifies app development entrypoints share one Node-backed Vite command,
 * including force mode and fail-fast dependency diagnostics.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveViteCommand } from "../../../app-core/scripts/lib/dev-ui-vite.mjs";

const appDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const viteCli = path.join(appDir, "node_modules", "vite", "bin", "vite.js");

describe("development Vite process commands", () => {
  it("runs the shared server through the current Node executable", () => {
    assert.deepEqual(
      resolveViteCommand({
        appDir,
        nodePath: "/usr/local/bin/node",
      }),
      {
        command: "/usr/local/bin/node",
        args: [viteCli],
      },
    );
  });

  it("builds dashboard commands with the requested force and port flags", () => {
    const command = resolveViteCommand({
      appDir,
      force: true,
      nodePath: "/usr/bin/node",
      port: 2138,
    });

    assert.deepEqual(command, {
      command: "/usr/bin/node",
      args: [viteCli, "--force", "--port", "2138"],
    });
    assert.deepEqual(
      resolveViteCommand({
        appDir,
        force: false,
        nodePath: "/usr/bin/node",
        port: 2138,
      }),
      {
        command: "/usr/bin/node",
        args: [viteCli, "--port", "2138"],
      },
    );
  });

  it("fails before spawning when Node or the Vite CLI is unavailable", () => {
    assert.throws(
      () =>
        resolveViteCommand({
          appDir,
          force: false,
          nodePath: null,
          port: 2138,
        }),
      /Node.js is required/,
    );
    assert.throws(
      () =>
        resolveViteCommand({
          appDir: path.join(appDir, "missing"),
          force: false,
          nodePath: "/usr/bin/node",
          port: 2138,
        }),
      /Vite CLI not found/,
    );
  });
});
