/**
 * Behavioral unit coverage for default agent workspace resolution. Drives the
 * real module: every exported helper, project-marker detection, packaged-runtime
 * exclusion, env/project/persisted/cwd/profile precedence, and the unreadable
 * folder-config fallthrough. Deterministic — no mocks of the resolver.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  resolveDefaultAgentWorkspaceDir,
  shouldBootstrapWorkspaceInitFiles,
  shouldUseRuntimeCwdWorkspace,
} from "./workspace-resolution.ts";

const PROJECT_WORKSPACE_MARKERS = [
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "skills",
  ".git",
] as const;

const PACKAGED_RUNTIME_SEGMENTS = [
  "eliza-dist",
  path.join("Contents", "Resources", "app"),
  path.join("resources", "app"),
  "self-extraction",
] as const;

let tmpDirs: string[] = [];

function makeTmp(prefix = "ws-resolution-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function isolatedEnv(
  stateDir: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return { ELIZA_STATE_DIR: stateDir, ...extra };
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeMarker(dir: string, marker: string): void {
  mkdirSync(dir, { recursive: true });
  const markerPath = path.join(dir, marker);
  if (marker === "skills" || marker === ".git") {
    mkdirSync(markerPath, { recursive: true });
    return;
  }
  writeFileSync(markerPath, "{}\n");
}

afterEach(() => {
  const dirs = tmpDirs;
  tmpDirs = [];
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("shouldUseRuntimeCwdWorkspace", () => {
  it("rejects empty, whitespace, and marker-free directories", () => {
    const empty = makeTmp("ws-empty-");
    expect(shouldUseRuntimeCwdWorkspace("")).toBe(false);
    expect(shouldUseRuntimeCwdWorkspace("   ")).toBe(false);
    expect(shouldUseRuntimeCwdWorkspace(empty)).toBe(false);
  });

  it.each(PROJECT_WORKSPACE_MARKERS)(
    "treats a directory containing %s as a project workspace",
    (marker) => {
      const dir = makeTmp("ws-marker-");
      writeMarker(dir, marker);
      expect(shouldUseRuntimeCwdWorkspace(dir)).toBe(true);
    },
  );

  it.each(PACKAGED_RUNTIME_SEGMENTS)(
    "rejects a packaged runtime path containing %s even when a marker exists",
    (segment) => {
      const root = makeTmp("ws-packaged-");
      const dir = path.join(root, segment, "app");
      writeMarker(dir, "package.json");
      expect(shouldUseRuntimeCwdWorkspace(dir)).toBe(false);
    },
  );

  it("matches packaged-runtime segments case-insensitively", () => {
    const root = makeTmp("ws-packaged-case-");
    const dir = path.join(root, "ELIZA-DIST", "payload");
    writeMarker(dir, "AGENTS.md");
    expect(shouldUseRuntimeCwdWorkspace(dir)).toBe(false);
  });
});

describe("shouldBootstrapWorkspaceInitFiles", () => {
  it("is the inverse of shouldUseRuntimeCwdWorkspace", () => {
    const project = makeTmp("ws-boot-project-");
    writeMarker(project, "package.json");
    const empty = makeTmp("ws-boot-empty-");
    const packagedRoot = makeTmp("ws-boot-packaged-");
    const packaged = path.join(packagedRoot, "eliza-dist", "app");
    writeMarker(packaged, "package.json");

    expect(shouldBootstrapWorkspaceInitFiles(project)).toBe(false);
    expect(shouldBootstrapWorkspaceInitFiles(empty)).toBe(true);
    expect(shouldBootstrapWorkspaceInitFiles(packaged)).toBe(true);
    expect(shouldBootstrapWorkspaceInitFiles("")).toBe(true);
  });
});

describe("resolveDefaultAgentWorkspaceDir", () => {
  it("returns the trimmed ELIZA_WORKSPACE_DIR over every other signal", () => {
    const stateDir = makeTmp("ws-state-");
    const explicit = path.join(stateDir, "from-env");
    const projectDir = path.join(stateDir, "active-project");
    mkdirSync(projectDir, { recursive: true });
    writeJson(path.join(stateDir, "projects.json"), {
      version: 1,
      activeProjectId: "p1",
      projects: [
        {
          id: "p1",
          name: "active",
          localPath: projectDir,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    writeJson(path.join(stateDir, "workspace-folder.json"), {
      path: path.join(stateDir, "persisted"),
      bookmark: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const resolved = resolveDefaultAgentWorkspaceDir(
      isolatedEnv(stateDir, {
        ELIZA_WORKSPACE_DIR: `  ${explicit}  `,
      }),
      () => stateDir,
      () => path.join(stateDir, "cwd-with-package"),
    );
    expect(resolved).toBe(path.resolve(explicit));
  });

  it("ignores a whitespace-only ELIZA_WORKSPACE_DIR and continues precedence", () => {
    const stateDir = makeTmp("ws-ws-env-blank-");
    const resolved = resolveDefaultAgentWorkspaceDir(
      isolatedEnv(stateDir, { ELIZA_WORKSPACE_DIR: "   " }),
      () => stateDir,
      () => "/",
    );
    expect(resolved).toBe(path.join(stateDir, "workspace"));
  });

  it("resolves a relative ELIZA_WORKSPACE_DIR against process.cwd", () => {
    const stateDir = makeTmp("ws-relative-");
    const resolved = resolveDefaultAgentWorkspaceDir(
      isolatedEnv(stateDir, { ELIZA_WORKSPACE_DIR: "relative-workspace" }),
      () => stateDir,
      () => "/",
    );
    expect(resolved).toBe(path.resolve("relative-workspace"));
  });

  it("expands a leading tilde in ELIZA_WORKSPACE_DIR via os.homedir", () => {
    const stateDir = makeTmp("ws-tilde-");
    const resolved = resolveDefaultAgentWorkspaceDir(
      isolatedEnv(stateDir, { ELIZA_WORKSPACE_DIR: "~/eliza-tilde-workspace" }),
      () => stateDir,
      () => "/",
    );
    expect(resolved).toBe(path.resolve(os.homedir(), "eliza-tilde-workspace"));
  });

  it("returns the active project's localPath when no env override is set", () => {
    const stateDir = makeTmp("ws-active-");
    const active = path.join(stateDir, "active-project");
    mkdirSync(active, { recursive: true });
    writeJson(path.join(stateDir, "projects.json"), {
      version: 1,
      activeProjectId: "p1",
      projects: [
        {
          id: "p1",
          name: "active",
          localPath: active,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const resolved = resolveDefaultAgentWorkspaceDir(
      isolatedEnv(stateDir),
      () => stateDir,
      () => "/",
    );
    expect(resolved).toBe(path.resolve(active));
  });

  it("skips an active project whose localPath is only whitespace", () => {
    const stateDir = makeTmp("ws-active-blank-");
    writeJson(path.join(stateDir, "projects.json"), {
      version: 1,
      activeProjectId: "p1",
      projects: [
        {
          id: "p1",
          name: "blank",
          localPath: "   ",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const resolved = resolveDefaultAgentWorkspaceDir(
      isolatedEnv(stateDir),
      () => stateDir,
      () => "/",
    );
    expect(resolved).toBe(path.join(stateDir, "workspace"));
  });

  it("uses workspace-folder.json when the registry has no matching active project", () => {
    const stateDir = makeTmp("ws-persisted-");
    const persisted = path.join(stateDir, "user-picked");
    writeJson(path.join(stateDir, "projects.json"), {
      version: 1,
      activeProjectId: "missing",
      projects: [],
    });
    writeJson(path.join(stateDir, "workspace-folder.json"), {
      path: persisted,
      bookmark: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const resolved = resolveDefaultAgentWorkspaceDir(
      isolatedEnv(stateDir),
      () => stateDir,
      () => "/",
    );
    expect(resolved).toBe(path.resolve(persisted));
  });

  it("swallows an unreadable workspace-folder.json when a registry is present", () => {
    const stateDir = makeTmp("ws-folder-eisdir-");
    writeJson(path.join(stateDir, "projects.json"), {
      version: 1,
      activeProjectId: null,
      projects: [],
    });
    mkdirSync(path.join(stateDir, "workspace-folder.json"));

    const resolved = resolveDefaultAgentWorkspaceDir(
      isolatedEnv(stateDir),
      () => stateDir,
      () => "/",
    );
    expect(resolved).toBe(path.join(stateDir, "workspace"));
  });

  it("falls back to the state-dir workspace when unreadable legacy state has no registry (#25884)", () => {
    const stateDir = makeTmp("ws-legacy-throw-");
    mkdirSync(path.join(stateDir, "workspace-folder.json"));

    const resolved = resolveDefaultAgentWorkspaceDir(
      isolatedEnv(stateDir),
      () => stateDir,
      () => "/",
    );
    expect(resolved).toBe(path.join(stateDir, "workspace"));
  });

  it("falls through malformed workspace-folder JSON to the state-dir default", () => {
    const stateDir = makeTmp("ws-malformed-");
    writeJson(path.join(stateDir, "projects.json"), {
      version: 1,
      activeProjectId: null,
      projects: [],
    });
    writeFileSync(path.join(stateDir, "workspace-folder.json"), "{not-json", {
      encoding: "utf8",
    });

    const resolved = resolveDefaultAgentWorkspaceDir(
      isolatedEnv(stateDir),
      () => stateDir,
      () => "/",
    );
    expect(resolved).toBe(path.join(stateDir, "workspace"));
  });

  it("uses the runtime cwd when it looks like a project and ELIZA_STATE_DIR is unset", () => {
    const home = makeTmp("ws-xdg-home-");
    const cwd = makeTmp("ws-cwd-project-");
    writeMarker(cwd, "package.json");
    const env: NodeJS.ProcessEnv = { XDG_STATE_HOME: home };

    const resolved = resolveDefaultAgentWorkspaceDir(
      env,
      () => home,
      () => cwd,
    );
    expect(resolved).toBe(path.resolve(cwd));
  });

  it("does not use a marker-bearing cwd when ELIZA_STATE_DIR is set", () => {
    const stateDir = makeTmp("ws-state-pinned-");
    const cwd = makeTmp("ws-cwd-ignored-");
    writeMarker(cwd, "package.json");

    const resolved = resolveDefaultAgentWorkspaceDir(
      isolatedEnv(stateDir),
      () => stateDir,
      () => cwd,
    );
    expect(resolved).toBe(path.join(stateDir, "workspace"));
  });

  it("skips an empty, whitespace, or non-function cwd", () => {
    const home = makeTmp("ws-xdg-empty-cwd-");
    const env: NodeJS.ProcessEnv = { XDG_STATE_HOME: home };

    expect(
      resolveDefaultAgentWorkspaceDir(
        env,
        () => home,
        () => "",
      ),
    ).toBe(path.join(home, "eliza", "workspace"));
    expect(
      resolveDefaultAgentWorkspaceDir(
        env,
        () => home,
        () => "   ",
      ),
    ).toBe(path.join(home, "eliza", "workspace"));
    // Default parameters only substitute for `undefined`; a non-function
    // argument skips the cwd heuristic instead of calling process.cwd.
    expect(
      resolveDefaultAgentWorkspaceDir(
        env,
        () => home,
        null as unknown as () => string,
      ),
    ).toBe(path.join(home, "eliza", "workspace"));
  });

  it("does not treat a packaged runtime cwd as a project workspace", () => {
    const home = makeTmp("ws-xdg-packaged-cwd-");
    const packagedRoot = makeTmp("ws-packaged-cwd-");
    const cwd = path.join(packagedRoot, "eliza-dist", "app");
    writeMarker(cwd, "package.json");
    const env: NodeJS.ProcessEnv = { XDG_STATE_HOME: home };

    const resolved = resolveDefaultAgentWorkspaceDir(
      env,
      () => home,
      () => cwd,
    );
    expect(resolved).toBe(path.join(home, "eliza", "workspace"));
  });

  it("scopes a non-default ELIZA_PROFILE under workspace-<profile>", () => {
    const stateDir = makeTmp("ws-profile-");
    const resolved = resolveDefaultAgentWorkspaceDir(
      isolatedEnv(stateDir, { ELIZA_PROFILE: "  Work  " }),
      () => stateDir,
      () => "/",
    );
    expect(resolved).toBe(path.join(stateDir, "workspace-Work"));
  });

  it.each(["default", "DEFAULT", "Default", "  default  ", ""])(
    "uses <stateDir>/workspace when ELIZA_PROFILE is %j",
    (profile) => {
      const stateDir = makeTmp("ws-profile-default-");
      const resolved = resolveDefaultAgentWorkspaceDir(
        isolatedEnv(stateDir, { ELIZA_PROFILE: profile }),
        () => stateDir,
        () => "/",
      );
      expect(resolved).toBe(path.join(stateDir, "workspace"));
    },
  );
});

describe("DEFAULT_AGENT_WORKSPACE_DIR", () => {
  it("is the import-time resolution of the process environment", () => {
    expect(typeof DEFAULT_AGENT_WORKSPACE_DIR).toBe("string");
    expect(DEFAULT_AGENT_WORKSPACE_DIR.length).toBeGreaterThan(0);
    expect(DEFAULT_AGENT_WORKSPACE_DIR).toBe(resolveDefaultAgentWorkspaceDir());
  });
});
