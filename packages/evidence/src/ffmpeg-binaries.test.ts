import { describe, expect, it } from "vitest";
import { resolveNodeInstallRunner } from "./ffmpeg-binaries.ts";

describe("resolveNodeInstallRunner", () => {
  it("keeps the current executable when already running under Node", () => {
    expect(
      resolveNodeInstallRunner({
        env: {},
        execPath: "/opt/node/bin/node",
      }),
    ).toBe("/opt/node/bin/node");
    expect(
      resolveNodeInstallRunner({
        env: {},
        execPath: "C:\\Program Files\\nodejs\\node.exe",
      }),
    ).toBe("C:\\Program Files\\nodejs\\node.exe");
  });

  it("uses node from PATH when invoked under Bun", () => {
    expect(
      resolveNodeInstallRunner({
        env: {},
        execPath: "/opt/homebrew/bin/bun",
      }),
    ).toBe("node");
  });

  it("honors an explicit Node binary override", () => {
    expect(
      resolveNodeInstallRunner({
        env: { ELIZA_NODE_BIN: "/custom/node" },
        execPath: "/opt/homebrew/bin/bun",
      }),
    ).toBe("/custom/node");
    expect(
      resolveNodeInstallRunner({
        env: { NODE_BINARY: "/toolchain/node" },
        execPath: "/opt/homebrew/bin/bun",
      }),
    ).toBe("/toolchain/node");
  });
});
