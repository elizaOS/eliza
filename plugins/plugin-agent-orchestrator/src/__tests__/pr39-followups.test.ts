/**
 * Regression tests for the three bugs found in PR #39 (Discord UX bundle):
 *
 *   Bug 1: looksLikeProseTask false-positives on shell commands that contain
 *          file extensions or relative paths (`cat README.md`, `find .`).
 *   Bug 2: seedClaudeTrustForWorkdir read-modify-write race when multiple
 *          swarm agents spawn concurrently.
 *   Bug 3: unguarded `startCodingTaskAction.handler!` bang assertion.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coerceShellAgentTypeForProse } from "../actions/start-coding-task.js";

// ---------------------------------------------------------------------------
// Bug 1: looksLikeProseTask via its one exported caller
// ---------------------------------------------------------------------------

describe("coerceShellAgentTypeForProse — shell-command false-positives", () => {
  // Shell hint + shell command should be preserved.
  it.each([
    ["shell", "df -h"],
    ["shell", "git status -s"],
    ["shell", "find . -name '*.ts'"],
    ["shell", "cat README.md"],
    ["shell", "ls *.md"],
    ["shell", "rm /tmp/foo.log"],
    ["shell", "./script.sh"],
    ["shell", "cat ./foo"],
    ["bash", "pwd"],
    ["pi", "uptime"],
  ])("keeps agentType=%s for bare shell command: %s", (hint, text) => {
    const result = coerceShellAgentTypeForProse(hint, text, "[test]");
    expect(result).toBe(hint);
  });

  // Shell hint + prose task should be upgraded (return undefined so
  // resolveAgentType picks a reasoning framework).
  it.each([
    ["shell", "check disk usage on this vps"],
    ["shell", "add a todo to fix that PR"],
    ["shell", "build a timer page"],
    ["shell", "please debug the login flow"],
    ["shell", "summarize the meeting."],
    ["shell", "Do it!"],
    ["shell", "Why does this fail?"],
    ["bash", "investigate the failing test and report back"],
    ["pi", "write a one-page summary of my notes"],
  ])("upgrades agentType=%s for prose: %s", (hint, text) => {
    const result = coerceShellAgentTypeForProse(hint, text, "[test]");
    expect(result).toBeUndefined();
  });

  it("leaves non-shell hints alone regardless of text", () => {
    expect(
      coerceShellAgentTypeForProse("claude", "build a timer app", "[t]"),
    ).toBe("claude");
    expect(coerceShellAgentTypeForProse("codex", "df -h", "[t]")).toBe("codex");
  });

  it("returns undefined when no hint is provided", () => {
    expect(
      coerceShellAgentTypeForProse(undefined, "anything", "[t]"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bug 2: seed-trust serialization
// ---------------------------------------------------------------------------

// seedClaudeTrustForWorkdir is internal to pty-service.ts but reads/writes
// $HOME/.claude.json. Exercise it by importing pty-service's side-effect-
// free helper indirectly: we can't reach the function directly without an
// export, so we emulate the same read-modify-write pattern under concurrent
// load and assert the helper's invariants hold. The real fix's correctness
// is that all workdirs seeded by parallel calls survive in the final file.
//
// For this test we import the pty-service module and call its internal
// function through a dedicated export added for testability.

describe("seedClaudeTrustForWorkdir — concurrent writes preserve all entries", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "claude-trust-test-"));
    configPath = path.join(tmpDir, ".claude.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("interleaved spawns for different workdirs do not clobber each other", async () => {
    const { seedClaudeTrustForWorkdirForTesting } = await import(
      "../services/pty-service.js"
    );

    const workdirs = Array.from({ length: 8 }, (_, i) => `/tmp/work-${i}`);
    // Kick all seeds off in parallel. Without the queue they would race the
    // read-modify-write on ~/.claude.json; with it they serialize and every
    // workdir survives.
    await Promise.all(
      workdirs.map((w) => seedClaudeTrustForWorkdirForTesting(w, configPath)),
    );

    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    for (const w of workdirs) {
      expect(parsed.projects?.[w]?.hasTrustDialogAccepted).toBe(true);
    }
  });

  it("is a no-op when the workdir is already trusted and preserves unknown fields", async () => {
    const { seedClaudeTrustForWorkdirForTesting } = await import(
      "../services/pty-service.js"
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        projects: {
          "/tmp/already-trusted": {
            hasTrustDialogAccepted: true,
            someUnmodeledField: "preserve-me",
          },
        },
        topLevelUnmodeled: "also-preserve-me",
      }),
    );

    await seedClaudeTrustForWorkdirForTesting(
      "/tmp/already-trusted",
      configPath,
    );

    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      projects?: Record<
        string,
        { hasTrustDialogAccepted?: boolean; someUnmodeledField?: string }
      >;
      topLevelUnmodeled?: string;
    };
    expect(
      parsed.projects?.["/tmp/already-trusted"]?.hasTrustDialogAccepted,
    ).toBe(true);
    expect(parsed.projects?.["/tmp/already-trusted"]?.someUnmodeledField).toBe(
      "preserve-me",
    );
    expect(parsed.topLevelUnmodeled).toBe("also-preserve-me");
  });

  it("creates the file when it does not exist (ENOENT path)", async () => {
    const { seedClaudeTrustForWorkdirForTesting } = await import(
      "../services/pty-service.js"
    );
    // Don't pre-create configPath — exercise the ENOENT branch.

    await seedClaudeTrustForWorkdirForTesting("/tmp/fresh", configPath);

    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    expect(parsed.projects?.["/tmp/fresh"]?.hasTrustDialogAccepted).toBe(true);
  });
});
