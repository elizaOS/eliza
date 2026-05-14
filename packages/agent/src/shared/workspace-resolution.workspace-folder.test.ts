/**
 * Regression test: when no `ELIZA_WORKSPACE_DIR` env var is set but the user
 * has picked a workspace folder via the desktop RPC (which writes
 * `<stateDir>/workspace-folder.json`), the agent runtime's
 * `resolveDefaultAgentWorkspaceDir()` honors that file.
 *
 * This is the boot-time bridge that lets store-distributed desktop builds
 * scope the agent's filesystem reach to the user-granted folder.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { writeWorkspaceFolderConfig } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveDefaultAgentWorkspaceDir } from "./workspace-resolution.ts";

describe("resolveDefaultAgentWorkspaceDir + workspace-folder.json", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(os.tmpdir(), "ws-resolution-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns the persisted workspace folder when no ELIZA_WORKSPACE_DIR is set", () => {
    const userPickedFolder = join(stateDir, "user-picked");
    writeWorkspaceFolderConfig(
      { path: userPickedFolder, bookmark: "base64bookmark" },
      { MILADY_STATE_DIR: stateDir },
    );

    const resolved = resolveDefaultAgentWorkspaceDir(
      { MILADY_STATE_DIR: stateDir },
      () => stateDir,
      () => "/",
    );

    expect(resolved).toBe(userPickedFolder);
  });

  it("ELIZA_WORKSPACE_DIR env var still wins over persisted config", () => {
    const explicit = join(stateDir, "explicit-env-wins");
    writeWorkspaceFolderConfig(
      { path: join(stateDir, "persisted"), bookmark: null },
      { MILADY_STATE_DIR: stateDir },
    );

    const resolved = resolveDefaultAgentWorkspaceDir(
      {
        MILADY_STATE_DIR: stateDir,
        ELIZA_WORKSPACE_DIR: explicit,
      },
      () => stateDir,
      () => "/",
    );

    expect(resolved).toBe(explicit);
  });

  it("falls back to <stateDir>/workspace when neither env nor config is set", () => {
    const resolved = resolveDefaultAgentWorkspaceDir(
      { MILADY_STATE_DIR: stateDir },
      () => stateDir,
      () => "/",
    );
    expect(resolved).toBe(join(stateDir, "workspace"));
  });
});
