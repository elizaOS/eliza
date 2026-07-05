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
import {
  setActiveProject,
  upsertProject,
  writeWorkspaceFolderConfig,
} from "@elizaos/core";
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
      { ELIZA_STATE_DIR: stateDir },
    );

    const resolved = resolveDefaultAgentWorkspaceDir(
      { ELIZA_STATE_DIR: stateDir },
      () => stateDir,
      () => "/",
    );

    expect(resolved).toBe(userPickedFolder);
  });

  it("ELIZA_WORKSPACE_DIR env var still wins over persisted config", () => {
    const explicit = join(stateDir, "explicit-env-wins");
    writeWorkspaceFolderConfig(
      { path: join(stateDir, "persisted"), bookmark: null },
      { ELIZA_STATE_DIR: stateDir },
    );

    const resolved = resolveDefaultAgentWorkspaceDir(
      {
        ELIZA_STATE_DIR: stateDir,
        ELIZA_WORKSPACE_DIR: explicit,
      },
      () => stateDir,
      () => "/",
    );

    expect(resolved).toBe(explicit);
  });

  it("falls back to <stateDir>/workspace when neither env nor config is set", () => {
    const resolved = resolveDefaultAgentWorkspaceDir(
      { ELIZA_STATE_DIR: stateDir },
      () => stateDir,
      () => "/",
    );
    expect(resolved).toBe(join(stateDir, "workspace"));
  });

  it("returns the active project's localPath from projects.json over the legacy config", () => {
    const active = join(stateDir, "active-project");
    const project = upsertProject(
      { name: "active-project", localPath: active },
      { ELIZA_STATE_DIR: stateDir },
    );
    setActiveProject(project.id, { ELIZA_STATE_DIR: stateDir });
    // A legacy config also present — the registry must win.
    writeWorkspaceFolderConfig(
      { path: join(stateDir, "legacy"), bookmark: null },
      { ELIZA_STATE_DIR: stateDir },
    );

    const resolved = resolveDefaultAgentWorkspaceDir(
      { ELIZA_STATE_DIR: stateDir },
      () => stateDir,
      () => "/",
    );
    expect(resolved).toBe(active);
  });

  it("ELIZA_WORKSPACE_DIR env var still wins over the active project", () => {
    const explicit = join(stateDir, "explicit-env-wins");
    const project = upsertProject(
      { name: "p", localPath: join(stateDir, "active-project") },
      { ELIZA_STATE_DIR: stateDir },
    );
    setActiveProject(project.id, { ELIZA_STATE_DIR: stateDir });

    const resolved = resolveDefaultAgentWorkspaceDir(
      { ELIZA_STATE_DIR: stateDir, ELIZA_WORKSPACE_DIR: explicit },
      () => stateDir,
      () => "/",
    );
    expect(resolved).toBe(explicit);
  });

  it("absent registry preserves legacy workspace-folder.json behavior byte-for-byte", () => {
    // No projects.json written. The registry synthesizes an active project from
    // the legacy config on read, so resolution must equal the pre-registry
    // behavior: the persisted folder path.
    const userPickedFolder = join(stateDir, "legacy-only");
    writeWorkspaceFolderConfig(
      { path: userPickedFolder, bookmark: null },
      { ELIZA_STATE_DIR: stateDir },
    );

    const resolved = resolveDefaultAgentWorkspaceDir(
      { ELIZA_STATE_DIR: stateDir },
      () => stateDir,
      () => "/",
    );
    expect(resolved).toBe(userPickedFolder);
  });
});
