/**
 * Exercises both terminal capability APIs with real temporary executables and
 * a controlled executable-lookup collaborator. Host boot-PATH authority is
 * covered by the shared host-execution-env suite, not this lookup stub.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as shell from "../shell/utils/terminalCapabilities.js";
import * as coding from "./terminal-capabilities.js";

vi.mock("@elizaos/core/host-execution-env", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@elizaos/core/host-execution-env")>();
  const { accessSync, constants } = await import("node:fs");
  const pathApi = await import("node:path");
  return {
    ...actual,
    resolveHostExecutable: (nameOrPath: string): string | undefined => {
      const candidates = pathApi.isAbsolute(nameOrPath)
        ? [nameOrPath]
        : (process.env.PATH ?? "")
            .split(pathApi.delimiter)
            .filter(Boolean)
            .map((entry) => pathApi.join(entry, nameOrPath));
      return candidates.find((candidate) => {
        try {
          accessSync(candidate, constants.X_OK);
          return true;
        } catch {
          // error-policy:J3 Fixture executable probing returns explicit absence.
          return false;
        }
      });
    },
  };
});

const ENV_KEYS = [
  "ELIZA_PLATFORM",
  "ELIZA_AOSP_BUILD",
  "ELIZA_RUNTIME_MODE",
  "RUNTIME_MODE",
  "LOCAL_RUNTIME_MODE",
  "ELIZA_BUILD_VARIANT",
  "ANDROID_ROOT",
  "ANDROID_DATA",
  "CODING_TOOLS_SHELL",
  "SHELL",
  "PATH",
] as const;

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "ct-cap-"));
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
  vi.stubEnv("PATH", tempDir);
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } finally {
    vi.unstubAllEnvs();
  }
});

function executable(name: string): string {
  const file = path.join(tempDir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

describe.each([
  {
    name: "coding-tools",
    detectTerminalSupport: coding.detectTerminalSupport,
    resolveExecutable: coding.resolveExecutable,
    resolveShell: coding.resolveHostShell,
    missingTool: coding.missingToolForCommand,
  },
  {
    name: "compatibility shell",
    detectTerminalSupport: shell.detectTerminalSupport,
    resolveExecutable: shell.resolveExecutable,
    resolveShell: shell.resolveTerminalShell,
    missingTool: shell.missingTerminalToolForCommand,
  },
])(
  "$name terminal capability detection",
  ({ detectTerminalSupport, resolveExecutable, resolveShell, missingTool }) => {
    it("ignores mutable shell overrides when choosing a staged executable", () => {
      const shell = executable("sh");
      process.env.ELIZA_PLATFORM = "android";
      process.env.CODING_TOOLS_SHELL = executable("aosp-sh");
      process.env.SHELL = "/definitely/missing";
      process.env.PATH = tempDir;

      const resolved = resolveShell();

      expect(resolved.available).toBe(true);
      expect("command" in resolved ? resolved.command : resolved.shell).toBe(
        shell,
      );
      expect(resolved.source).toBe("candidate");
    });

    it("detects Android PATH binaries without invoking which", () => {
      const git = executable("git");
      process.env.ELIZA_PLATFORM = "android";
      process.env.PATH = tempDir;

      expect(resolveExecutable("git")).toBe(git);
      expect(missingTool("git status")).toBeUndefined();
      expect(missingTool("codex exec test")).toBe("codex");
      expect(missingTool("acpx codex prompt hi")).toBe("acpx");
    });

    it("accepts direct Android local-yolo when a shell is executable", () => {
      const shell = executable("sh");
      process.env.ELIZA_PLATFORM = "android";
      process.env.ELIZA_RUNTIME_MODE = "local-yolo";
      process.env.CODING_TOOLS_SHELL = shell;
      process.env.PATH = tempDir;

      const support = detectTerminalSupport();

      expect(support.supported).toBe(true);
    });

    it("rejects Play/store Android even when local-yolo has a staged shell", () => {
      const shell = executable("sh");
      process.env.ELIZA_BUILD_VARIANT = "store";
      process.env.ELIZA_PLATFORM = "android";
      process.env.ELIZA_RUNTIME_MODE = "local-yolo";
      process.env.CODING_TOOLS_SHELL = shell;
      process.env.PATH = tempDir;

      const support = detectTerminalSupport();

      expect(support.supported).toBe(false);
      expect(support.reason).toBe("store_build");
    });

    it("rejects iOS terminal support", () => {
      process.env.ELIZA_PLATFORM = "ios";
      process.env.ELIZA_RUNTIME_MODE = "local-yolo";

      const support = detectTerminalSupport();

      expect(support.supported).toBe(false);
      expect(support.reason).toBe("vanilla_mobile");
      expect(support.message).toContain("iOS");
    });

    it("accepts branded AOSP local-yolo when a shell is executable", () => {
      const shell = executable("sh");
      process.env.ELIZA_PLATFORM = "android";
      process.env.ELIZA_AOSP_BUILD = "1";
      process.env.ELIZA_RUNTIME_MODE = "local-yolo";
      process.env.CODING_TOOLS_SHELL = shell;
      process.env.PATH = tempDir;

      const support = detectTerminalSupport();

      expect(support.supported).toBe(true);
    });

    it("rejects Android outside local-yolo mode", () => {
      const shell = executable("sh");
      process.env.ELIZA_PLATFORM = "android";
      process.env.ELIZA_AOSP_BUILD = "1";
      process.env.ELIZA_RUNTIME_MODE = "local-safe";
      process.env.CODING_TOOLS_SHELL = shell;
      process.env.PATH = tempDir;

      const support = detectTerminalSupport();

      expect(support.supported).toBe(false);
      expect(support.reason).toBe("not_local_yolo");
    });
  },
);
