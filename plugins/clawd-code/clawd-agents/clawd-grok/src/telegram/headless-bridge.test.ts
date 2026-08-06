import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTelegramHeadlessBridgePaths } from "./headless-bridge-paths";

describe("resolveTelegramHeadlessBridgePaths", () => {
  it("uses default files in the provided cwd", () => {
    const cwd = path.resolve("fixture-workspace");

    expect(resolveTelegramHeadlessBridgePaths(cwd)).toEqual({
      logFile: path.resolve(cwd, "telegram-remote-bridge.log"),
      pairCodeFile: path.resolve(cwd, "telegram-pair-code.txt"),
    });
  });

  it("resolves custom relative paths from the provided cwd", () => {
    const cwd = path.resolve("fixture-workspace");

    expect(
      resolveTelegramHeadlessBridgePaths(cwd, {
        logFile: path.join("logs", "bridge.log"),
        pairCodeFile: path.join("state", "pair.txt"),
      }),
    ).toEqual({
      logFile: path.resolve(cwd, "logs", "bridge.log"),
      pairCodeFile: path.resolve(cwd, "state", "pair.txt"),
    });
  });
});
