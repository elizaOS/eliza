/**
 * Proves the dist probe cannot inherit source conditions or hide child failures.
 */
import { describe, expect, it, vi } from "vitest";
import { verifyBuiltPackage } from "./verify-built-package.mjs";

describe("verifyBuiltPackage", () => {
  it("imports with default conditions in an isolated child", () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    verifyBuiltPackage({
      spawn,
      environment: {
        NODE_OPTIONS: "--conditions=eliza-source --trace-warnings",
        PATH: "/bin",
      },
      executable: "/node",
    });

    expect(spawn).toHaveBeenCalledOnce();
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe("/node");
    expect(args).toContain("--input-type=module");
    expect(args.join(" ")).toContain("@elizaos/plugin-elizacloud");
    expect(options.env).toEqual({ PATH: "/bin" });
  });

  it("fails when the built public import fails", () => {
    expect(() =>
      verifyBuiltPackage({
        spawn: () => ({ status: 1, stdout: "", stderr: "missing dist entry" }),
      }),
    ).toThrow("missing dist entry");
  });
});
