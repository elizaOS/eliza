/**
 * Unit tests for task-agent-auth: probeTaskAgentAuth dep injection and
 * ENOENT classification (the Windows .cmd extension failure mode).
 */

import { describe, expect, it, vi } from "vitest";
import {
  getTaskAgentLoginHint,
  isTaskAgentNonInteractiveAuthFailure,
  normalizeTaskAgentAdapterId,
  probeTaskAgentAuth,
} from "../services/task-agent-auth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecFile(
  result: { stdout: string; stderr: string } | Error,
): (
  file: string,
  args: string[],
  opts?: { encoding?: string; env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<{ stdout: string; stderr: string }> {
  return vi.fn(async (_file, _args, _opts) => {
    if (result instanceof Error) throw result;
    return result;
  });
}

// ---------------------------------------------------------------------------
// normalizeTaskAgentAdapterId
// ---------------------------------------------------------------------------

describe("normalizeTaskAgentAdapterId", () => {
  it("maps 'claude' and 'claude code' to 'claude'", () => {
    expect(normalizeTaskAgentAdapterId("claude")).toBe("claude");
    expect(normalizeTaskAgentAdapterId("Claude Code")).toBe("claude");
  });

  it("maps 'codex' to 'codex'", () => {
    expect(normalizeTaskAgentAdapterId("codex")).toBe("codex");
  });

  it("returns null for unknown adapters", () => {
    expect(normalizeTaskAgentAdapterId("unknown-tool")).toBeNull();
    expect(normalizeTaskAgentAdapterId(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getTaskAgentLoginHint
// ---------------------------------------------------------------------------

describe("getTaskAgentLoginHint", () => {
  it("returns a login hint for claude", () => {
    const hint = getTaskAgentLoginHint("claude");
    expect(hint).toContain("claude setup-token");
    expect(hint).toContain("claude auth login --claudeai");
  });

  it("returns a login hint for codex", () => {
    const hint = getTaskAgentLoginHint("codex");
    expect(hint).toMatch(/codex login/);
  });
});

describe("isTaskAgentNonInteractiveAuthFailure", () => {
  it("detects Claude Code 401 output from non-interactive runs", () => {
    expect(
      isTaskAgentNonInteractiveAuthFailure(
        "claude",
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
      ),
    ).toBe(true);
  });

  it("does not classify unrelated adapters as Claude auth failures", () => {
    expect(
      isTaskAgentNonInteractiveAuthFailure(
        "codex",
        "401 invalid authentication credentials",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// probeTaskAgentAuth – claude
// ---------------------------------------------------------------------------

describe("probeTaskAgentAuth – claude", () => {
  it("returns authenticated when output contains loggedIn:true JSON", async () => {
    const execFile = makeExecFile({
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      stderr: "",
    });
    const result = await probeTaskAgentAuth("claude", { deps: { execFile } });
    expect(result.status).toBe("authenticated");
    expect(result.method).toBe("claude.ai");
    expect(execFile).toHaveBeenCalledOnce();
    const [file, args] = (execFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(file).toBe("claude");
    expect(args).toEqual(["auth", "status"]);
  });

  it("returns unauthenticated when output contains loggedIn:false", async () => {
    const execFile = makeExecFile({
      stdout: JSON.stringify({ loggedIn: false }),
      stderr: "",
    });
    const result = await probeTaskAgentAuth("claude", { deps: { execFile } });
    expect(result.status).toBe("unauthenticated");
    expect(result.loginHint).toBeTruthy();
  });

  it("returns authenticated when plain-text output says 'logged in'", async () => {
    const execFile = makeExecFile({
      stdout: "You are logged in as user@example.com",
      stderr: "",
    });
    const result = await probeTaskAgentAuth("claude", { deps: { execFile } });
    expect(result.status).toBe("authenticated");
  });

  it("returns unknown when execFile throws ENOENT (Windows .cmd extension failure)", async () => {
    const enoent = new Error(
      "ENOENT: no such file or directory, uv_spawn 'claude'",
    );
    const execFile = makeExecFile(enoent);
    const result = await probeTaskAgentAuth("claude", { deps: { execFile } });
    // ENOENT does not match 'not logged in' so status should be 'unknown',
    // not 'unauthenticated' — we don't want to show a false "needs login" hint
    // when the real problem is a missing binary on Windows without .cmd resolution.
    expect(result.status).toBe("unknown");
    expect(result.detail).toMatch(/uv_spawn/);
  });
});

// ---------------------------------------------------------------------------
// probeTaskAgentAuth – codex
// ---------------------------------------------------------------------------

describe("probeTaskAgentAuth – codex", () => {
  it("returns authenticated when output says 'logged in'", async () => {
    const execFile = makeExecFile({
      stdout: "Logged in as user@example.com",
      stderr: "",
    });
    const result = await probeTaskAgentAuth("codex", { deps: { execFile } });
    expect(result.status).toBe("authenticated");
    const [file, args] = (execFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(file).toBe("codex");
    expect(args).toEqual(["login", "status"]);
  });

  it("returns unauthenticated when output says 'not logged in'", async () => {
    const execFile = makeExecFile({
      stdout: "Not logged in",
      stderr: "",
    });
    const result = await probeTaskAgentAuth("codex", { deps: { execFile } });
    expect(result.status).toBe("unauthenticated");
  });

  it("returns unknown when execFile throws ENOENT (Windows .cmd extension failure)", async () => {
    const enoent = new Error(
      "ENOENT: no such file or directory, uv_spawn 'codex'",
    );
    const execFile = makeExecFile(enoent);
    const result = await probeTaskAgentAuth("codex", { deps: { execFile } });
    expect(result.status).toBe("unknown");
    expect(result.detail).toMatch(/uv_spawn/);
  });
});
