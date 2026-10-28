/**
 * Regression guard for the shell-approval command gate: a command whose
 * executable starts with `~` must be analyzed instead of aborting the gate.
 *
 * The defect this pins is a bare `require("node:os")` in an ESM module, so it
 * is only observable under Node's own ESM loader — Vitest's SSR transform and
 * Bun both define `require` in ESM. The red/green evidence for the fix is a
 * Node-ESM probe recorded in the pull request; this file keeps the `~`
 * expansion contract covered inside the normal suite.
 */
import * as os from "node:os";
import { describe, expect, it } from "vitest";
import {
  evaluateShellAllowlist,
  resolveCommandResolution,
} from "./analysis.js";

describe("shell-approval command analysis", () => {
  it("resolves a `~`-prefixed executable instead of aborting", () => {
    const resolution = resolveCommandResolution("~/bin/definitely-absent-tool");
    expect(resolution?.rawExecutable).toBe("~/bin/definitely-absent-tool");
    // Not on disk under the real home directory: reported verbatim and the
    // caller keeps analysing, rather than throwing out of the gate.
    expect(resolution?.executableName).toBe("~/bin/definitely-absent-tool");
    expect(resolution?.resolvedPath ?? null).toBeNull();
  });

  it("keeps analysing a `~` command through the allowlist gate", () => {
    const result = evaluateShellAllowlist({
      command: "~/.local/bin/definitely-absent-tool --flag",
      allowlist: [],
      safeBins: new Set(),
      cwd: os.homedir(),
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segments[0]?.argv).toEqual([
      "~/.local/bin/definitely-absent-tool",
      "--flag",
    ]);
  });
});
