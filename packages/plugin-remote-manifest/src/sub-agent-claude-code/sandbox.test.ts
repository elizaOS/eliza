/**
 * Claude Code sandbox tests validate filesystem policy rendering and path
 * handling for the reference remote sub-agent sandbox assets.
 */
import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
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

  it("fuzzes extraEnv keys so sensitive names are never forwarded", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "TOKEN",
          "SECRET",
          "KEY",
          "PASSWORD",
          "CREDENTIAL",
          "DATABASE_URL",
          "WALLET",
          "PRIVATE",
          "MNEMONIC",
          "API_KEY",
        ),
        fc.string({ minLength: 1, maxLength: 24 }).filter((value) => {
          return /^[A-Za-z0-9_]+$/.test(value);
        }),
        fc.string({ minLength: 1, maxLength: 24 }).filter((value) => {
          return /^[A-Za-z0-9_]+$/.test(value);
        }),
        (marker, left, right) => {
          const key = `${left}_${marker}_${right}`;
          expect(() =>
            filterEnv({} as NodeJS.ProcessEnv, SAFE_ENV_KEYS, {
              [key]: "do-not-forward",
            }),
          ).toThrow(/sensitive env var/);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("resolveSafeCwd", () => {
  it("accepts a path inside a workspace root", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ws-")));
    expect(resolveSafeCwd(root, [root])).toBe(root);
  });

  it("rejects a path outside the workspace root and tmp", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ws-")));
    const outside = realpathSync("/dev");
    expect(() => resolveSafeCwd(outside, [root])).toThrow(SubAgentCwdError);
  });

  it("rejects non-absolute paths", () => {
    expect(() => resolveSafeCwd("relative/path", ["/tmp"])).toThrow(
      SubAgentCwdError,
    );
  });

  it("rejects files and symlink escapes", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ws-")));
    const file = join(root, "file.txt");
    const escapePath = join(root, "escape");
    writeFileSync(file, "not a directory");
    symlinkSync("/dev", escapePath);

    expect(() => resolveSafeCwd(file, [root])).toThrow(SubAgentCwdError);
    expect(() => resolveSafeCwd(escapePath, [root])).toThrow(SubAgentCwdError);
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
    const blockedBinary = join(root, "claude");
    writeFileSync(blockedBinary, "#!/bin/sh\necho test binary\n");
    chmodSync(blockedBinary, 0o755);
    expect(() => resolveSafeBinary(blockedBinary)).toThrow(SubAgentBinaryError);
  });

  it("resolves a bare binary name only from whitelisted PATH entries", () => {
    const binary = resolveSafeBinary("env", {
      PATH: ["/tmp/not-allowed", "/usr/bin"].join(":"),
    } as NodeJS.ProcessEnv);

    expect(binary).toBe("/usr/bin/env");
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

  it("discovers bundled Linux wrapper without truncating the bwrap argv", async () => {
    const wrapper = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "sandbox",
      "linux-bwrap.sh",
    );

    expect(existsSync(wrapper)).toBe(true);
    expect(statSync(wrapper).mode & 0o111).not.toBe(0);
    await expect(Bun.file(wrapper).text()).resolves.not.toContain(
      "2>/dev/null || true \\",
    );
  });
});
