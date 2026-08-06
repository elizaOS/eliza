import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getWorkspaceTrustDecision,
  getWorkspaceTrustKey,
  getWorkspaceTrustPath,
  isShuruSandboxSupported,
  loadWorkspaceTrustStore,
  resolveWorkspaceTrustPromptAnswer,
  saveWorkspaceTrustDecision,
  WORKSPACE_TRUST_FILENAME,
} from "./workspace-trust";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("workspace trust settings", () => {
  it("detects Shuru support only on macOS Apple Silicon", () => {
    expect(isShuruSandboxSupported("darwin", "arm64")).toBe(true);
    expect(isShuruSandboxSupported("darwin", "x64")).toBe(false);
    expect(isShuruSandboxSupported("linux", "arm64")).toBe(false);
    expect(isShuruSandboxSupported("win32", "x64")).toBe(false);
  });

  it("only disables supported sandbox mode on explicit no answers", () => {
    expect(resolveWorkspaceTrustPromptAnswer("", true)).toEqual({ sandboxMode: "shuru", remember: true });
    expect(resolveWorkspaceTrustPromptAnswer("y", true)).toEqual({ sandboxMode: "shuru", remember: true });
    expect(resolveWorkspaceTrustPromptAnswer("typo", true)).toEqual({ sandboxMode: "shuru", remember: true });
    expect(resolveWorkspaceTrustPromptAnswer("n", true)).toEqual({ sandboxMode: "off", remember: true });
    expect(resolveWorkspaceTrustPromptAnswer("no", true)).toEqual({ sandboxMode: "off", remember: true });
    expect(resolveWorkspaceTrustPromptAnswer("s", true)).toEqual({ sandboxMode: "shuru", remember: false });
  });

  it("keeps unsupported sandbox prompt decisions in host mode", () => {
    expect(resolveWorkspaceTrustPromptAnswer("", false)).toEqual({ sandboxMode: "off", remember: true });
    expect(resolveWorkspaceTrustPromptAnswer("typo", false)).toEqual({ sandboxMode: "off", remember: true });
    expect(resolveWorkspaceTrustPromptAnswer("s", false)).toEqual({ sandboxMode: "off", remember: false });
  });

  it("stores sandbox decisions by canonical workspace path", () => {
    const homeDir = createTempDir("grok-trust-home-");
    const workspace = createTempDir("grok-trust-workspace-");
    const trustPath = getWorkspaceTrustPath(homeDir);

    saveWorkspaceTrustDecision(workspace, "shuru", trustPath);

    expect(getWorkspaceTrustDecision(workspace, trustPath)).toBe("shuru");
    expect(loadWorkspaceTrustStore(trustPath).workspaces[getWorkspaceTrustKey(workspace)]?.sandboxMode).toBe("shuru");
    expect(path.basename(trustPath)).toBe(WORKSPACE_TRUST_FILENAME);
  });

  it("preserves existing entries when saving another workspace", () => {
    const homeDir = createTempDir("grok-trust-home-");
    const firstWorkspace = createTempDir("grok-trust-first-");
    const secondWorkspace = createTempDir("grok-trust-second-");
    const trustPath = getWorkspaceTrustPath(homeDir);

    saveWorkspaceTrustDecision(firstWorkspace, "shuru", trustPath);
    saveWorkspaceTrustDecision(secondWorkspace, "off", trustPath);

    expect(getWorkspaceTrustDecision(firstWorkspace, trustPath)).toBe("shuru");
    expect(getWorkspaceTrustDecision(secondWorkspace, trustPath)).toBe("off");
  });

  it("ignores malformed files and entries", () => {
    const homeDir = createTempDir("grok-trust-home-");
    const workspace = createTempDir("grok-trust-workspace-");
    const trustPath = getWorkspaceTrustPath(homeDir);
    fs.mkdirSync(path.dirname(trustPath), { recursive: true });
    fs.writeFileSync(
      trustPath,
      JSON.stringify({
        workspaces: {
          [getWorkspaceTrustKey(workspace)]: { sandboxMode: "invalid" },
        },
      }),
    );

    expect(getWorkspaceTrustDecision(workspace, trustPath)).toBeNull();
    expect(loadWorkspaceTrustStore(path.join(homeDir, ".grok", "broken.json"))).toEqual({
      version: 1,
      workspaces: {},
    });
  });
});
