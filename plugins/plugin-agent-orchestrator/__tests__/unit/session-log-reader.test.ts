/**
 * Tests for the Claude Code session-log reader + merger (W1-T1, closes C1
 * Claude path). Covers:
 *
 *   1. Path resolution (canonical `~/.claude/projects/...` + workspace-local
 *      fallback, missing-dir no-throw contract).
 *   2. JSONL parsing of real-shape Claude Code transcripts (assistant text,
 *      thinking, tool_use; user tool_result; malformed-line tolerance).
 *   3. Normalization into trajectory step records.
 *   4. End-to-end merge into a mocked trajectory logger, asserting the
 *      parent step's `childSteps[]` is appended and the steps land with
 *      the right kind / model / usage.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeSessionLogIntoTrajectory } from "../../src/services/session-log-merger.js";
import {
  buildSessionLogCandidates,
  encodeClaudeCodeProjectDir,
  findClaudeCodeSessionLogFile,
  normalizeSessionEvents,
  parseSessionLogFile,
  parseSessionLogLine,
  readClaudeCodeSession,
} from "../../src/services/session-log-reader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFixtureJsonl(): string {
  // Verbatim shape from a real Claude Code transcript. Includes:
  //  - thinking block (reasoning capture)
  //  - tool_use (Grep)
  //  - tool_result on a separate user row
  //  - text-only final assistant turn
  //  - one queue-operation housekeeping row we must ignore
  //  - one deliberately malformed line we must skip without throwing
  const lines = [
    {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-04-21T01:34:34.308Z",
      sessionId: "session-fixture-1",
    },
    {
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: "Find references to openExternalUrl" },
      uuid: "u-0001",
      timestamp: "2026-04-21T01:34:34.740Z",
      sessionId: "session-fixture-1",
      cwd: "/tmp/fixture",
    },
    {
      parentUuid: "u-0001",
      type: "assistant",
      message: {
        model: "claude-opus-4-7",
        id: "msg-fixture-001",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Need to grep for the symbol first." },
          {
            type: "tool_use",
            id: "toolu-grep-1",
            name: "Grep",
            input: {
              pattern: "openExternalUrl",
              output_mode: "files_with_matches",
            },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 12,
          output_tokens: 90,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 1024,
        },
      },
      uuid: "a-0001",
      timestamp: "2026-04-21T01:34:35.000Z",
      sessionId: "session-fixture-1",
      cwd: "/tmp/fixture",
      requestId: "req-abc",
    },
    {
      parentUuid: "a-0001",
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu-grep-1",
            content: "Found 2 files\nsrc/a.ts\nsrc/b.ts",
          },
        ],
      },
      uuid: "u-0002",
      timestamp: "2026-04-21T01:34:35.500Z",
      sessionId: "session-fixture-1",
      toolUseResult: { numFiles: 2 },
    },
    {
      parentUuid: "u-0002",
      type: "assistant",
      message: {
        model: "claude-opus-4-7",
        id: "msg-fixture-002",
        role: "assistant",
        content: [
          { type: "text", text: "Found references in src/a.ts and src/b.ts." },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 30, output_tokens: 25 },
      },
      uuid: "a-0002",
      timestamp: "2026-04-21T01:34:36.000Z",
      sessionId: "session-fixture-1",
    },
  ];
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n{not json}\n`;
}

describe("session-log-reader: path resolution", () => {
  it("encodes Claude Code project dir paths (/ and . → -)", () => {
    expect(encodeClaudeCodeProjectDir("/Users/x/.milady/workspaces/abc")).toBe(
      "-Users-x--milady-workspaces-abc",
    );
  });

  it("returns both canonical and workspace-local candidates", () => {
    const candidates = buildSessionLogCandidates("/tmp/repo", "/home/me");
    expect(candidates).toEqual([
      {
        dir: "/home/me/.claude/projects/-tmp-repo",
        label: "claude-projects",
      },
      {
        dir: "/tmp/repo/.claude/session-logs",
        label: "workspace-local",
      },
    ]);
  });

  it("does not throw when no candidate dirs exist", async () => {
    const home = await makeTempDir("session-log-home-");
    const workdir = await makeTempDir("session-log-workdir-");
    await expect(
      findClaudeCodeSessionLogFile(workdir, undefined, home),
    ).resolves.toBeNull();
  });

  it("locates the most recent jsonl in the canonical dir", async () => {
    const home = await makeTempDir("session-log-home-");
    const workdir = "/Users/x/myproj";
    const projectsDir = join(
      home,
      ".claude",
      "projects",
      encodeClaudeCodeProjectDir(workdir),
    );
    await mkdir(projectsDir, { recursive: true });
    const older = join(
      projectsDir,
      "00000000-0000-0000-0000-000000000001.jsonl",
    );
    const newer = join(
      projectsDir,
      "00000000-0000-0000-0000-000000000002.jsonl",
    );
    await writeFile(older, "");
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(newer, "");
    const located = await findClaudeCodeSessionLogFile(
      workdir,
      undefined,
      home,
    );
    expect(located?.filePath).toBe(newer);
  });
});

describe("session-log-reader: parsing", () => {
  it("returns null for blank, junk, or non-object lines", () => {
    expect(parseSessionLogLine("")).toBeNull();
    expect(parseSessionLogLine("   ")).toBeNull();
    expect(parseSessionLogLine("not json")).toBeNull();
    expect(parseSessionLogLine("[1,2,3]")).toBeNull();
    expect(parseSessionLogLine('{"no_type":"x"}')).toBeNull();
  });

  it("parses an assistant message with thinking + tool_use", () => {
    const raw = JSON.stringify({
      parentUuid: null,
      type: "assistant",
      uuid: "a-1",
      timestamp: "2026-04-21T01:34:35.000Z",
      sessionId: "s",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [
          { type: "thinking", thinking: "let's think" },
          { type: "tool_use", id: "t-1", name: "Grep", input: { p: "x" } },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    const ev = parseSessionLogLine(raw);
    expect(ev?.type).toBe("assistant");
    if (ev?.type !== "assistant") throw new Error("expected assistant");
    expect(ev.message.model).toBe("claude-opus-4-7");
    expect(ev.message.content).toHaveLength(2);
  });

  it("parses an entire fixture transcript with malformed-line tolerance", async () => {
    const dir = await makeTempDir("session-log-parse-");
    const file = join(dir, "session.jsonl");
    await writeFile(file, makeFixtureJsonl());
    const events = await parseSessionLogFile(file);
    // 5 typed rows (queue-op, user, assistant, user, assistant); malformed
    // line dropped silently.
    expect(events.length).toBe(5);
    expect(events.map((e) => e.type)).toEqual([
      "queue-operation",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });
});

describe("session-log-reader: normalization", () => {
  it("emits one normalized step per content block", async () => {
    const dir = await makeTempDir("session-log-normalize-");
    const file = join(dir, "session.jsonl");
    await writeFile(file, makeFixtureJsonl());
    const events = await parseSessionLogFile(file);
    const steps = normalizeSessionEvents(events, "parent-step-1");

    // reasoning + tool_call + tool_result + text = 4
    expect(steps).toHaveLength(4);
    expect(steps.map((s) => s.kind)).toEqual([
      "reasoning",
      "tool_call",
      "tool_result",
      "text",
    ]);

    const reasoning = steps[0];
    expect(reasoning.reasoning).toBe("Need to grep for the symbol first.");
    expect(reasoning.model).toBe("claude-opus-4-7");
    expect(reasoning.usage?.input_tokens).toBe(12);
    expect(reasoning.usage?.cache_creation_input_tokens).toBe(1024);

    const toolCall = steps[1];
    expect(toolCall.toolName).toBe("Grep");
    expect(toolCall.toolInput).toEqual({
      pattern: "openExternalUrl",
      output_mode: "files_with_matches",
    });
    expect(toolCall.toolUseId).toBe("toolu-grep-1");
    expect(toolCall.requestId).toBe("req-abc");

    const toolResult = steps[2];
    expect(toolResult.toolUseId).toBe("toolu-grep-1");
    expect(toolResult.toolResult).toContain("src/a.ts");
    expect(toolResult.toolError).toBe(false);

    const text = steps[3];
    expect(text.text).toContain("src/a.ts and src/b.ts");
    expect(text.usage?.input_tokens).toBe(30);

    // Every child step id is parent-scoped and unique.
    const ids = new Set(steps.map((s) => s.stepId));
    expect(ids.size).toBe(steps.length);
    for (const id of ids) expect(id.startsWith("parent-step-1-cc-")).toBe(true);
  });

  it("flags is_error on tool_result blocks", () => {
    const raw = JSON.stringify({
      parentUuid: "x",
      type: "user",
      uuid: "u-err",
      timestamp: "2026-04-21T01:34:36.000Z",
      sessionId: "s",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t-fail",
            content: "rate limit",
            is_error: true,
          },
        ],
      },
    });
    const parsed = parseSessionLogLine(raw);
    if (!parsed) throw new Error("expected session log event");
    const events = [parsed];
    const steps = normalizeSessionEvents(events, "p");
    expect(steps).toHaveLength(1);
    expect(steps[0].toolError).toBe(true);
    expect(steps[0].toolResult).toBe("rate limit");
  });
});

describe("readClaudeCodeSession (integration)", () => {
  it("returns reason=missing when no log file exists", async () => {
    const home = await makeTempDir("session-log-int-home-");
    const workdir = await makeTempDir("session-log-int-workdir-");
    const result = await readClaudeCodeSession({
      workspaceDir: workdir,
      parentStepId: "p",
      home,
    });
    expect(result.reason).toBe("missing");
    expect(result.steps).toHaveLength(0);
  });

  it("locates + parses + normalizes the canonical Claude Code log", async () => {
    const home = await makeTempDir("session-log-int-home-");
    const workdir = "/tmp/fixture-app";
    const projectsDir = join(
      home,
      ".claude",
      "projects",
      encodeClaudeCodeProjectDir(workdir),
    );
    await mkdir(projectsDir, { recursive: true });
    await writeFile(
      join(projectsDir, "session-fixture-1.jsonl"),
      makeFixtureJsonl(),
    );

    const result = await readClaudeCodeSession({
      workspaceDir: workdir,
      parentStepId: "step-parent-abc",
      home,
    });
    expect(result.reason).toBe("ok");
    expect(result.sessionId).toBe("session-fixture-1");
    expect(result.steps.map((s) => s.kind)).toEqual([
      "reasoning",
      "tool_call",
      "tool_result",
      "text",
    ]);
    expect(result.models).toEqual(["claude-opus-4-7"]);
    expect(result.totalUsage.input_tokens).toBe(42);
    expect(result.totalUsage.output_tokens).toBe(115);
    expect(result.totalUsage.cache_creation_input_tokens).toBe(1024);
  });

  it("also probes the workspace-local fallback dir", async () => {
    const home = await makeTempDir("session-log-int-home-");
    const workdir = await makeTempDir("session-log-int-workdir-");
    const local = join(workdir, ".claude", "session-logs");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "session-local.jsonl"), makeFixtureJsonl());
    const result = await readClaudeCodeSession({
      workspaceDir: workdir,
      parentStepId: "p",
      home,
    });
    expect(result.reason).toBe("ok");
    expect(result.steps.length).toBeGreaterThan(0);
  });
});

describe("mergeSessionLogIntoTrajectory", () => {
  function mockLogger() {
    return {
      isEnabled: () => true,
      startTrajectory: vi.fn(
        async (id: string, opts?: unknown) => ({ id, opts }) as never,
      ),
      startStep: vi.fn((id: string) => id),
      logLlmCall: vi.fn(),
      annotateStep: vi.fn(),
      endTrajectory: vi.fn(async () => undefined),
    };
  }

  function mockRuntime(logger: ReturnType<typeof mockLogger>) {
    return {
      agentId: "agent-test",
      getService: (name: string) =>
        name === "trajectories" ? logger : undefined,
      getServicesByType: (type: string) =>
        type === "trajectories" ? [logger] : [],
    } as never;
  }

  it("returns no-steps when capture is empty", async () => {
    const logger = mockLogger();
    const result = await mergeSessionLogIntoTrajectory({
      runtime: mockRuntime(logger),
      parentStepId: "p",
      capture: { steps: [], totalUsage: {}, models: [], reason: "empty" },
    });
    expect(result.skippedReason).toBe("no-steps");
    expect(logger.startTrajectory).not.toHaveBeenCalled();
  });

  it("returns no-trajectory-logger when none is registered", async () => {
    const runtime = {
      agentId: "agent-test",
      getService: () => undefined,
      getServicesByType: () => [],
    } as never;
    const result = await mergeSessionLogIntoTrajectory({
      runtime,
      parentStepId: "p",
      capture: {
        steps: [
          {
            stepId: "p-cc-0001-x",
            kind: "text",
            timestamp: 0,
            source: "claude-code",
            sessionId: "s",
            parentUuid: null,
            text: "hi",
          },
        ],
        totalUsage: {},
        models: [],
        reason: "ok",
      },
    });
    expect(result.skippedReason).toBe("no-trajectory-logger");
  });

  it("writes one LLM call per llm-kind step + annotates tool_result steps + links parent", async () => {
    const home = await makeTempDir("session-log-merge-home-");
    const workdir = "/tmp/fixture-merge";
    const projectsDir = join(
      home,
      ".claude",
      "projects",
      encodeClaudeCodeProjectDir(workdir),
    );
    await mkdir(projectsDir, { recursive: true });
    await writeFile(
      join(projectsDir, "session-fixture-1.jsonl"),
      makeFixtureJsonl(),
    );
    const capture = await readClaudeCodeSession({
      workspaceDir: workdir,
      parentStepId: "parent-step-merge",
      home,
    });

    const logger = mockLogger();
    const result = await mergeSessionLogIntoTrajectory({
      runtime: mockRuntime(logger),
      parentStepId: "parent-step-merge",
      capture,
      ptySessionId: "pty-1",
      agentType: "claude",
      workspaceDir: workdir,
    });

    expect(result.stepsWritten).toBe(4);
    expect(logger.startTrajectory).toHaveBeenCalledTimes(1);
    const startCall = logger.startTrajectory.mock.calls[0];
    expect(startCall[1]?.source).toBe("claude-code-session");
    expect(startCall[1]?.metadata).toMatchObject({
      parentTrajectoryStepId: "parent-step-merge",
      subAgentType: "claude",
      ptySessionId: "pty-1",
      workspaceDir: workdir,
      claudeCodeSessionId: "session-fixture-1",
      models: ["claude-opus-4-7"],
    });

    // reasoning + tool_call + text are LLM calls; tool_result is annotated.
    expect(logger.logLlmCall).toHaveBeenCalledTimes(3);
    expect(logger.annotateStep).toHaveBeenCalledTimes(2);

    // First annotate is the tool_result step, second is the parent step
    // linking the child trajectory.
    const annotateCalls = logger.annotateStep.mock.calls;
    expect(annotateCalls[0][0]).toMatchObject({
      kind: "action",
    });
    expect(annotateCalls[0][0].script).toContain("toolu-grep-1");

    expect(annotateCalls[1][0]).toMatchObject({
      stepId: "parent-step-merge",
      appendChildSteps: [result.childTrajectoryId],
    });

    expect(logger.endTrajectory).toHaveBeenCalledWith(
      result.childTrajectoryId,
      "completed",
    );
  });
});
