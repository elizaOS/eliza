// @vitest-environment node
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AdbFlasherBackend } from "../backend/adb-backend";
import { DependencyManager } from "./dep-manager";
import { findHostTool } from "./host-tools";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "setup-tools-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function binary(path: string, contents = "#!/bin/sh\nexit 0\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode: 0o755 });
  return path;
}

test("discovers extracted Windows platform tools with executable suffix", () => {
  const adb = binary(
    join(home, ".elizaos/flasher/vendor/bin/win32/platform-tools/adb.exe"),
  );
  expect(findHostTool("adb", { home, platform: "win32", env: {} })).toBe(adb);
});

test("checks SDK and PATH and skips directories or non-executable files", () => {
  const sdk = join(home, "sdk");
  const path = join(home, "path");
  const sdkAdb = binary(join(sdk, "platform-tools/adb"));
  const pathAdb = binary(join(path, "adb"));
  const options = {
    home,
    platform: "linux" as const,
    env: { ANDROID_HOME: sdk, PATH: path },
  };
  expect(findHostTool("adb", options)).toBe(sdkAdb);
  chmodSync(sdkAdb, 0o644);
  expect(findHostTool("adb", options)).toBe(pathAdb);
  rmSync(pathAdb);
  mkdirSync(pathAdb);
  expect(findHostTool("adb", options)).toBeUndefined();
});

test.skipIf(process.platform === "win32")(
  "dependency check and existing backend use a newly installed vendor tool",
  async () => {
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", "");
    vi.stubEnv("ANDROID_HOME", "");
    vi.stubEnv("ANDROID_SDK_ROOT", "");
    const marker = join(home, "invocation");
    vi.stubEnv("ELIZA_TOOL_PROBE", marker);
    const backend = new AdbFlasherBackend();
    const adb = binary(
      join(
        home,
        `.elizaos/flasher/vendor/bin/${process.platform}/platform-tools/adb`,
      ),
      '#!/bin/sh\nprintf "%s\\n" "$*" > "$ELIZA_TOOL_PROBE"\nprintf "List of devices attached\\n"\n',
    );
    const check = await new DependencyManager().checkOne("adb");
    binary(join(dirname(adb), "fastboot"));
    expect(check.status).toBe("found");
    expect(findHostTool("adb")).toBe(adb);
    expect(await backend.listConnectedDevices()).toEqual([]);
    expect(readFileSync(marker, "utf8")).toBe("devices -l\n");
  },
);
