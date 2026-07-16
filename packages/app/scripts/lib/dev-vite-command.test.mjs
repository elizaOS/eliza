/**
 * Verifies both development entrypoints resolve the installed Vite CLI through
 * Node, including force mode and fail-fast dependency diagnostics.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { resolveDevUiViteCommand } from "../../../app-core/scripts/lib/dev-ui-vite.mjs";
import { buildSharedViteCommand } from "./dev-vite-command.mjs";

describe("development Vite process commands", () => {
  it("runs the shared server through the current Node executable", () => {
    assert.deepEqual(
      buildSharedViteCommand("/repo/packages/app", {
        execPath: "/usr/local/bin/node",
      }),
      {
        command: "/usr/local/bin/node",
        args: [
          path.join(
            "/repo/packages/app",
            "node_modules",
            "vite",
            "bin",
            "vite.js",
          ),
        ],
      },
    );
  });

  it("builds dashboard commands with the requested force and port flags", () => {
    const existsCalls = [];
    const command = resolveDevUiViteCommand({
      appDir: "packages/app",
      cwd: "/repo",
      exists: (value) => {
        existsCalls.push(value);
        return true;
      },
      force: true,
      nodePath: "/usr/bin/node",
      uiPort: 2138,
    });
    const viteCli = path.join(
      "/repo",
      "packages/app",
      "node_modules",
      "vite",
      "bin",
      "vite.js",
    );

    assert.deepEqual(command, {
      command: "/usr/bin/node",
      args: [viteCli, "--force", "--port", "2138"],
    });
    assert.deepEqual(
      resolveDevUiViteCommand({
        appDir: "packages/app",
        cwd: "/repo",
        exists: (value) => {
          existsCalls.push(value);
          return true;
        },
        force: false,
        nodePath: "/usr/bin/node",
        uiPort: 2138,
      }),
      {
        command: "/usr/bin/node",
        args: [viteCli, "--port", "2138"],
      },
    );
    assert.deepEqual(existsCalls, [viteCli, viteCli]);
  });

  it("fails before spawning when Node or the Vite CLI is unavailable", () => {
    assert.throws(
      () => buildSharedViteCommand("/repo", { execPath: "" }),
      /Node.js 24\+ is required/,
    );
    assert.throws(
      () =>
        resolveDevUiViteCommand({
          appDir: "packages/app",
          cwd: "/repo",
          exists: () => true,
          force: false,
          nodePath: null,
          uiPort: 2138,
        }),
      /Node.js 24\+ is required/,
    );
    assert.throws(
      () =>
        resolveDevUiViteCommand({
          appDir: "packages/app",
          cwd: "/repo",
          exists: () => false,
          force: false,
          nodePath: "/usr/bin/node",
          uiPort: 2138,
        }),
      /Vite CLI not found/,
    );
  });
});
