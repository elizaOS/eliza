/** Unit tests for shell resolution and coding-tool capability detection. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  detectTerminalSupport,
  missingToolForCommand,
  resolveExecutable,
  resolveHostShell,
} from "./terminal-capabilities.js";

vi.mock("@elizaos/shared/host-execution-env", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@elizaos/shared/host-execution-env")>();
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
  "ELIZA_BUILD_VARIANT",
  "CODING_TOOLS_SHELL",
  "SHELL",
  "PATH",
] as const;

let savedEnv: Record<string, string | undefined>;
let tempDir = "";

beforeAll(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tempDir = mkdtempSync(path.join(tmpdir(), "ct-cap-"));
  process.env.PATH = tempDir;
});

beforeEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.env.PATH = tempDir;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function executable(name: string): string {
  const file = path.join(tempDir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

describe("coding-tools terminal capability detection", () => {
  it("ignores mutable shell overrides and selects from the boot PATH", () => {
    const shell = executable("sh");
    process.env.ELIZA_PLATFORM = "android";
    process.env.CODING_TOOLS_SHELL = executable("aosp-sh");
    process.env.SHELL = "/definitely/missing";
    process.env.PATH = tempDir;

    const resolved = resolveHostShell();

    expect(resolved.available).toBe(true);
    expect(resolved.command).toBe(shell);
    expect(resolved.source).toBe("candidate");
  });

  it("detects Android PATH binaries without invoking which", () => {
    const git = executable("git");
    process.env.ELIZA_PLATFORM = "android";
    process.env.PATH = tempDir;

    expect(resolveExecutable("git")).toBe(git);
    expect(missingToolForCommand("git status")).toBeUndefined();
    expect(missingToolForCommand("codex exec test")).toBe("codex");
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
});
