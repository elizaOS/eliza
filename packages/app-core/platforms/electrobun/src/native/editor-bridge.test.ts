/**
 * Exercises the Electrobun native editor-bridge detection, launch, and
 * in-memory session APIs. PATH/`which` and executable-candidate probes are
 * stubbed at the OS boundary so results stay deterministic; workspace
 * existence uses real temp directories. Bun.spawn is stubbed so tests never
 * launch a native editor.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEditorSession,
  detectInstalledEditors,
  getActiveEditorSession,
  getEditorBridge,
  listInstalledEditors,
  type NativeEditorId,
  openInEditor,
} from "./editor-bridge";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const spawnSyncMock = vi.mocked(spawnSync);

const CATALOGUE = [
  { id: "vscode", label: "VS Code", command: "code" },
  { id: "cursor", label: "Cursor", command: "cursor" },
  { id: "windsurf", label: "Windsurf", command: "windsurf" },
  { id: "antigravity", label: "Antigravity", command: "ag" },
  { id: "zed", label: "Zed", command: "zed" },
  { id: "sublime", label: "Sublime Text", command: "subl" },
] as const;

const VSCODE_DARWIN_APP =
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
const VSCODE_DARWIN_HOME = path.join(
  os.homedir(),
  "Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
);

const tempRoots: string[] = [];
const originalPlatform = process.platform;

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-editor-bridge-"));
  tempRoots.push(dir);
  return dir;
}

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function mockCommandsOnPath(commands: ReadonlySet<string>): void {
  spawnSyncMock.mockImplementation((_bin, args) => {
    const cmd = Array.isArray(args) ? String(args[0]) : "";
    return { status: commands.has(cmd) ? 0 : 1 } as ReturnType<
      typeof spawnSync
    >;
  });
}

function denyAllExecutables(): void {
  vi.spyOn(fs, "accessSync").mockImplementation(() => {
    throw Object.assign(new Error("not executable"), { code: "EACCES" });
  });
}

function allowExecutable(target: string): void {
  vi.spyOn(fs, "accessSync").mockImplementation((candidate) => {
    if (String(candidate) === target) {
      return undefined;
    }
    throw Object.assign(new Error("not executable"), { code: "EACCES" });
  });
}

function stubSpawn(): { unref: ReturnType<typeof vi.fn> } {
  const unref = vi.fn();
  vi.spyOn(Bun, "spawn").mockReturnValue({
    unref,
  } as unknown as ReturnType<typeof Bun.spawn>);
  return { unref };
}

describe("editor-bridge", () => {
  beforeEach(() => {
    clearActiveEditorSession();
    vi.stubGlobal("Bun", { spawn: vi.fn() });
    spawnSyncMock.mockReset();
    mockCommandsOnPath(new Set());
    denyAllExecutables();
  });

  afterEach(() => {
    clearActiveEditorSession();
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const dir of tempRoots.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("returns the full catalogue as uninstalled when PATH and candidates miss", () => {
    const editors = detectInstalledEditors();

    expect(
      editors.map(({ id, label, command, installed }) => ({
        id,
        label,
        command,
        installed,
      })),
    ).toEqual(CATALOGUE.map((entry) => ({ ...entry, installed: false })));
  });

  it("lists an empty installed set when no editor is detected", () => {
    expect(listInstalledEditors()).toEqual([]);
  });

  it("keeps catalogue order when several editors are on PATH", () => {
    mockCommandsOnPath(new Set(["zed", "code"]));

    expect(listInstalledEditors().map((editor) => editor.id)).toEqual([
      "vscode",
      "zed",
    ]);
    expect(
      detectInstalledEditors().map((editor) => [editor.id, editor.installed]),
    ).toEqual([
      ["vscode", true],
      ["cursor", false],
      ["windsurf", false],
      ["antigravity", false],
      ["zed", true],
      ["sublime", false],
    ]);
  });

  it("returns a single PATH-detected editor without promoting the rest", () => {
    mockCommandsOnPath(new Set(["cursor"]));

    expect(listInstalledEditors()).toEqual([
      {
        id: "cursor",
        label: "Cursor",
        installed: true,
        command: "cursor",
      },
    ]);
  });

  it("prefers the PATH command over an executable candidate", () => {
    stubPlatform("darwin");
    mockCommandsOnPath(new Set(["code"]));
    allowExecutable(VSCODE_DARWIN_APP);

    const vscode = detectInstalledEditors().find(
      (editor) => editor.id === "vscode",
    );
    expect(vscode).toEqual({
      id: "vscode",
      label: "VS Code",
      installed: true,
      command: "code",
    });
  });

  it("uses the first executable candidate when the CLI is missing from PATH", () => {
    stubPlatform("darwin");
    mockCommandsOnPath(new Set());
    allowExecutable(VSCODE_DARWIN_APP);

    const vscode = detectInstalledEditors().find(
      (editor) => editor.id === "vscode",
    );
    expect(vscode).toEqual({
      id: "vscode",
      label: "VS Code",
      installed: true,
      command: VSCODE_DARWIN_APP,
    });
  });

  it("skips a missing earlier candidate and uses the next executable path", () => {
    stubPlatform("darwin");
    mockCommandsOnPath(new Set());
    allowExecutable(VSCODE_DARWIN_HOME);

    const vscode = detectInstalledEditors().find(
      (editor) => editor.id === "vscode",
    );
    expect(vscode?.installed).toBe(true);
    expect(vscode?.command).toBe(VSCODE_DARWIN_HOME);
  });

  it("treats an editor with no candidates for the platform as uninstalled", () => {
    stubPlatform("linux");
    mockCommandsOnPath(new Set());

    const antigravity = detectInstalledEditors().find(
      (editor) => editor.id === "antigravity",
    );
    expect(antigravity).toEqual({
      id: "antigravity",
      label: "Antigravity",
      installed: false,
      command: "ag",
    });
  });

  it("treats a thrown PATH probe as not installed", () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error("which failed");
    });

    expect(listInstalledEditors()).toEqual([]);
    expect(detectInstalledEditors().every((editor) => !editor.installed)).toBe(
      true,
    );
  });

  it("probes PATH with where on win32 and which elsewhere", () => {
    stubPlatform("win32");
    mockCommandsOnPath(new Set(["code"]));
    detectInstalledEditors();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "where",
      ["code"],
      expect.objectContaining({ stdio: "pipe", encoding: "utf8" }),
    );

    spawnSyncMock.mockClear();
    stubPlatform("darwin");
    mockCommandsOnPath(new Set(["code"]));
    detectInstalledEditors();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "which",
      ["code"],
      expect.objectContaining({ stdio: "pipe", encoding: "utf8" }),
    );
  });

  it("throws before spawn when the workspace path does not exist", () => {
    const { unref } = stubSpawn();
    mockCommandsOnPath(new Set(["code"]));
    const missing = path.join(
      os.tmpdir(),
      "eliza-editor-bridge-missing",
      "no-such-workspace",
    );

    expect(() => openInEditor("vscode", missing)).toThrow(
      `Workspace path does not exist: ${missing}`,
    );
    expect(Bun.spawn).not.toHaveBeenCalled();
    expect(unref).not.toHaveBeenCalled();
    expect(getActiveEditorSession()).toBeNull();
  });

  it("throws for an unknown editor id after the workspace exists", () => {
    const workspace = makeWorkspace();
    stubSpawn();

    expect(() => openInEditor("notepad" as NativeEditorId, workspace)).toThrow(
      "Unknown editor id: notepad",
    );
    expect(Bun.spawn).not.toHaveBeenCalled();
    expect(getActiveEditorSession()).toBeNull();
  });

  it("throws when the requested editor is not installed", () => {
    const workspace = makeWorkspace();
    stubSpawn();

    expect(() => openInEditor("vscode", workspace)).toThrow(
      'Editor "VS Code" is not installed',
    );
    expect(Bun.spawn).not.toHaveBeenCalled();
    expect(getActiveEditorSession()).toBeNull();
  });

  it("spawns the PATH command, unrefs the child, and records the session", () => {
    const workspace = makeWorkspace();
    mockCommandsOnPath(new Set(["code"]));
    const { unref } = stubSpawn();
    const before = Date.now();

    const session = openInEditor("vscode", workspace);
    const after = Date.now();

    expect(Bun.spawn).toHaveBeenCalledWith(["code", workspace], {
      stdio: ["ignore", "ignore", "ignore"],
      env: process.env,
    });
    expect(unref).toHaveBeenCalledTimes(1);
    expect(session.editorId).toBe("vscode");
    expect(session.workspacePath).toBe(workspace);
    expect(session.startedAt).toBeGreaterThanOrEqual(before);
    expect(session.startedAt).toBeLessThanOrEqual(after);
    expect(getActiveEditorSession()).toEqual(session);
  });

  it("spawns the resolved candidate path when PATH lookup fails", () => {
    stubPlatform("darwin");
    mockCommandsOnPath(new Set());
    allowExecutable(VSCODE_DARWIN_APP);
    const workspace = makeWorkspace();
    stubSpawn();

    const session = openInEditor("vscode", workspace);

    expect(Bun.spawn).toHaveBeenCalledWith(
      [VSCODE_DARWIN_APP, workspace],
      expect.objectContaining({
        stdio: ["ignore", "ignore", "ignore"],
      }),
    );
    expect(session.editorId).toBe("vscode");
    expect(getActiveEditorSession()).toBe(session);
  });

  it("replaces the previous in-memory session on a later open", () => {
    const first = makeWorkspace();
    const second = makeWorkspace();
    mockCommandsOnPath(new Set(["code", "cursor"]));
    stubSpawn();

    const firstSession = openInEditor("vscode", first);
    const secondSession = openInEditor("cursor", second);

    expect(secondSession).not.toEqual(firstSession);
    expect(getActiveEditorSession()).toEqual(secondSession);
    expect(getActiveEditorSession()?.editorId).toBe("cursor");
    expect(getActiveEditorSession()?.workspacePath).toBe(second);
  });

  it("starts with no session and clear is idempotent without closing an editor", () => {
    expect(getActiveEditorSession()).toBeNull();
    expect(() => clearActiveEditorSession()).not.toThrow();
    expect(getActiveEditorSession()).toBeNull();

    const workspace = makeWorkspace();
    mockCommandsOnPath(new Set(["zed"]));
    stubSpawn();
    openInEditor("zed", workspace);
    expect(getActiveEditorSession()?.editorId).toBe("zed");

    clearActiveEditorSession();
    expect(getActiveEditorSession()).toBeNull();
    clearActiveEditorSession();
    expect(getActiveEditorSession()).toBeNull();
    expect(Bun.spawn).toHaveBeenCalledTimes(1);
  });

  it("exposes the same functions through getEditorBridge", () => {
    const bridge = getEditorBridge();
    expect(bridge.listInstalledEditors).toBe(listInstalledEditors);
    expect(bridge.openInEditor).toBe(openInEditor);
    expect(bridge.getActiveEditorSession).toBe(getActiveEditorSession);
    expect(bridge.clearActiveEditorSession).toBe(clearActiveEditorSession);

    mockCommandsOnPath(new Set(["subl"]));
    expect(bridge.listInstalledEditors().map((editor) => editor.id)).toEqual([
      "sublime",
    ]);

    const workspace = makeWorkspace();
    stubSpawn();
    const session = bridge.openInEditor("sublime", workspace);
    expect(bridge.getActiveEditorSession()).toEqual(session);
    bridge.clearActiveEditorSession();
    expect(bridge.getActiveEditorSession()).toBeNull();
  });
});
