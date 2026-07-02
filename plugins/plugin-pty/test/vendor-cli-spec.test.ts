import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildClaudeCliSpec,
  buildCodexCliSpec,
  resolveClaudeCliBin,
  resolveCodexCliBin,
} from "../lib/vendor-cli-spec";

describe("buildClaudeCliSpec", () => {
  const base = { cwd: "/work/repo", binPath: "/usr/local/bin/claude" };

  it("launches the plain interactive claude TUI (no --print one-shot args)", () => {
    const spec = buildClaudeCliSpec(base);
    expect(spec.command).toBe("/usr/local/bin/claude");
    expect(spec.args).toEqual([]);
    expect(spec.cwd).toBe(path.resolve("/work/repo"));
    expect(spec.kind).toBe("claude");
    expect(spec.label).toBe("claude · interactive");
  });

  it("passes an explicit OAuth token through as CLAUDE_CODE_OAUTH_TOKEN", () => {
    const spec = buildClaudeCliSpec({ ...base, oauthToken: "sk-ant-oat-1" });
    expect(spec.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-1" });
  });

  it("omits CLAUDE_CODE_OAUTH_TOKEN when no token is configured (CLI reads ~/.claude/.credentials.json)", () => {
    for (const oauthToken of [undefined, "", "   "]) {
      const spec = buildClaudeCliSpec({ ...base, oauthToken });
      expect(
        Object.hasOwn(spec.env ?? {}, "CLAUDE_CODE_OAUTH_TOKEN"),
        JSON.stringify(oauthToken),
      ).toBe(false);
    }
  });

  it("merges extra env last", () => {
    const spec = buildClaudeCliSpec({
      ...base,
      oauthToken: "sk-ant-oat-1",
      extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: "sk-override", TERM: "xterm" },
    });
    expect(spec.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-override");
    expect(spec.env?.TERM).toBe("xterm");
  });

  it("rejects missing cwd / binPath with a clear message", () => {
    expect(() => buildClaudeCliSpec({ ...base, cwd: " " })).toThrow(/cwd/i);
    expect(() => buildClaudeCliSpec({ ...base, binPath: "" })).toThrow(
      /binPath/i,
    );
  });
});

describe("buildCodexCliSpec", () => {
  const base = { cwd: "/work/repo", binPath: "/usr/local/bin/codex" };

  it("launches the plain interactive codex TUI (no `codex exec` one-shot args)", () => {
    const spec = buildCodexCliSpec(base);
    expect(spec.command).toBe("/usr/local/bin/codex");
    expect(spec.args).toEqual([]);
    expect(spec.cwd).toBe(path.resolve("/work/repo"));
    expect(spec.kind).toBe("codex");
    expect(spec.label).toBe("codex · interactive");
  });

  it("passes an explicit auth dir through as CODEX_HOME", () => {
    const spec = buildCodexCliSpec({ ...base, codexHome: "/accounts/a1" });
    expect(spec.env).toMatchObject({ CODEX_HOME: "/accounts/a1" });
  });

  it("omits CODEX_HOME when unset (CLI reads ~/.codex/auth.json)", () => {
    for (const codexHome of [undefined, "", "   "]) {
      const spec = buildCodexCliSpec({ ...base, codexHome });
      expect(
        Object.hasOwn(spec.env ?? {}, "CODEX_HOME"),
        JSON.stringify(codexHome),
      ).toBe(false);
    }
  });

  it("merges extra env last", () => {
    const spec = buildCodexCliSpec({
      ...base,
      codexHome: "/accounts/a1",
      extraEnv: { CODEX_HOME: "/accounts/a2" },
    });
    expect(spec.env?.CODEX_HOME).toBe("/accounts/a2");
  });

  it("rejects missing cwd / binPath with a clear message", () => {
    expect(() => buildCodexCliSpec({ ...base, cwd: "" })).toThrow(/cwd/i);
    expect(() => buildCodexCliSpec({ ...base, binPath: "  " })).toThrow(
      /binPath/i,
    );
  });
});

describe("resolveClaudeCliBin", () => {
  it("uses PTY_CLAUDE_BIN when it points at an existing file", () => {
    const resolved = resolveClaudeCliBin({
      env: { PTY_CLAUDE_BIN: "/custom/claude" },
      exists: (p) => p === "/custom/claude",
    });
    expect(resolved).toBe(path.resolve("/custom/claude"));
  });

  it("throws when PTY_CLAUDE_BIN points at a missing file", () => {
    expect(() =>
      resolveClaudeCliBin({
        env: { PTY_CLAUDE_BIN: "/missing/claude" },
        exists: () => false,
      }),
    ).toThrow(/no file exists/i);
  });

  it("falls back to the first PATH entry containing the launcher", () => {
    const want = path.join("/home/dev/.local/bin", "claude");
    const resolved = resolveClaudeCliBin({
      env: { PATH: ["/usr/bin", "/home/dev/.local/bin"].join(path.delimiter) },
      exists: (p) => p === want,
    });
    expect(resolved).toBe(want);
  });

  it("throws actionable guidance when the CLI is not installed", () => {
    expect(() =>
      resolveClaudeCliBin({ env: { PATH: "/usr/bin" }, exists: () => false }),
    ).toThrow(/install it .*@anthropic-ai\/claude-code.*PTY_CLAUDE_BIN/is);
  });
});

describe("resolveCodexCliBin", () => {
  it("uses PTY_CODEX_BIN when it points at an existing file", () => {
    const resolved = resolveCodexCliBin({
      env: { PTY_CODEX_BIN: "/custom/codex" },
      exists: (p) => p === "/custom/codex",
    });
    expect(resolved).toBe(path.resolve("/custom/codex"));
  });

  it("throws when PTY_CODEX_BIN points at a missing file", () => {
    expect(() =>
      resolveCodexCliBin({
        env: { PTY_CODEX_BIN: "/missing/codex" },
        exists: () => false,
      }),
    ).toThrow(/no file exists/i);
  });

  it("falls back to the first PATH entry containing the launcher", () => {
    const want = path.join("/usr/local/bin", "codex");
    const resolved = resolveCodexCliBin({
      env: {
        PATH: ["/usr/local/bin", "/home/dev/.bun/bin"].join(path.delimiter),
      },
      exists: (p) => p === want,
    });
    expect(resolved).toBe(want);
  });

  it("throws actionable guidance when the CLI is not installed", () => {
    expect(() => resolveCodexCliBin({ env: {}, exists: () => false })).toThrow(
      /install it .*@openai\/codex.*PTY_CODEX_BIN/is,
    );
  });
});
