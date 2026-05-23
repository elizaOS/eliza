import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSandboxedCommand,
  filterEnv,
  resolveSafeBinary,
  resolveSafeCwd,
  SAFE_ENV_KEYS,
  SubAgentBinaryError,
  SubAgentCwdError,
} from "./sandbox.js";

describe("filterEnv", () => {
  it("only forwards allowlisted keys", () => {
    const result = filterEnv(
      {
        PATH: "/usr/bin",
        HOME: "/h",
        SOMETHING_ELSE: "x",
      } as NodeJS.ProcessEnv,
      SAFE_ENV_KEYS,
    );
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/h");
    expect("SOMETHING_ELSE" in result).toBe(false);
  });

  it("drops sensitive vars even when on the allowlist by accident", () => {
    const customAllow = new Set([...SAFE_ENV_KEYS, "MY_API_KEY"]);
    const result = filterEnv(
      { PATH: "/x", MY_API_KEY: "secret" } as NodeJS.ProcessEnv,
      customAllow,
    );
    expect("MY_API_KEY" in result).toBe(false);
  });

  it("rejects sensitive extraEnv keys", () => {
    expect(() =>
      filterEnv({} as NodeJS.ProcessEnv, SAFE_ENV_KEYS, {
        GITHUB_TOKEN: "ghp_x",
      }),
    ).toThrow(/sensitive env var/);
  });

  it("allows safe extraEnv keys", () => {
    const result = filterEnv({} as NodeJS.ProcessEnv, SAFE_ENV_KEYS, {
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    });
    expect(result.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });
});

describe("resolveSafeCwd", () => {
  it("accepts a path inside a workspace root", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ws-")));
    expect(resolveSafeCwd(root, [root])).toBe(root);
  });

  it("rejects a path outside the workspace root and tmp", () => {
    // realpath of homedir is never under /tmp on macOS or Linux, and never
    // inside the freshly-created workspace below — so it must be rejected.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ws-")));
    const outside = realpathSync(process.env.HOME ?? "/usr");
    // Sanity: if HOME happens to be under tmpdir for some reason, bail.
    if (outside.startsWith(realpathSync(tmpdir()))) return;
    expect(() => resolveSafeCwd(outside, [root])).toThrow(SubAgentCwdError);
  });

  it("rejects non-absolute paths", () => {
    expect(() => resolveSafeCwd("relative/path", ["/tmp"])).toThrow(
      SubAgentCwdError,
    );
  });
});

describe("resolveSafeBinary", () => {
  it("rejects relative paths with slashes", () => {
    expect(() => resolveSafeBinary("./bin/claude")).toThrow(
      SubAgentBinaryError,
    );
  });

  it("rejects absolute paths outside the whitelist", () => {
    const root = mkdtempSync(join(tmpdir(), "evil-"));
    const fake = join(root, "claude");
    writeFileSync(fake, "#!/bin/sh\necho fake\n");
    chmodSync(fake, 0o755);
    expect(() => resolveSafeBinary(fake)).toThrow(SubAgentBinaryError);
  });
});

describe("buildSandboxedCommand", () => {
  it("returns 'none' when no profile is supplied", () => {
    const plan = buildSandboxedCommand(["/bin/echo", "hi"], {
      workspaceRoot: "/tmp",
      sessionId: "s1",
    });
    expect(plan.sandbox).toBe("none");
    expect(plan.cmd).toEqual(["/bin/echo", "hi"]);
  });
});
