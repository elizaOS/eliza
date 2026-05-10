import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  aggregateStats,
  approxTokens,
  assembledPromptFor,
  compactModelPrompt,
  lineDiff,
  loadTrajectories,
  loadTrajectoryById,
  main,
  summarizeTrajectory,
} from "./inspect-trajectory.mjs";

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inspect-traj-"));
}

function writeTrajectory(dir, id, data) {
  const sub = path.join(dir, "agent-1");
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(sub, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

const SAMPLE_PROMPT_WITH_PLUGINS = `# About Test Agent
Some intro.

**Loaded Plugins:**
- @elizaos/plugin-foo
- @elizaos/plugin-bar
- @elizaos/plugin-baz

**System Plugins:**
- @elizaos/plugin-bootstrap

# Conversation Messages
user: hi

# Received Message
hello there
`;

function fakeTrajectory(id, opts = {}) {
  return {
    trajectoryId: id,
    agentId: "agent-1",
    roomId: "room-1",
    rootMessage: "hi",
    startedAt: opts.startedAt ?? 1_700_000_000_000,
    endedAt: opts.endedAt ?? 1_700_000_001_000,
    status: opts.status ?? "finished",
    source: opts.source ?? "messageHandler",
    metrics: { totalLatencyMs: 1000 },
    stages: opts.stages ?? [
      {
        stageId: "s0",
        kind: "messageHandler",
        startedAt: 1_700_000_000_000,
        endedAt: 1_700_000_000_500,
        latencyMs: 500,
        model: {
          modelType: "RESPONSE_HANDLER",
          provider: "anthropic",
          modelName: "claude-test",
          prompt: SAMPLE_PROMPT_WITH_PLUGINS,
          messages: [
            { role: "system", content: SAMPLE_PROMPT_WITH_PLUGINS },
            { role: "user", content: "hello there" },
          ],
          response: "Hi back.",
          toolCalls: [
            { id: "t1", name: "REPLY", args: { text: "Hi back." } },
          ],
          usage: {
            promptTokens: 100,
            completionTokens: 20,
            cacheReadInputTokens: 50,
            cacheCreationInputTokens: 10,
          },
          purpose: "respond",
          actionType: "REPLY",
        },
      },
      {
        stageId: "s1",
        kind: "planner",
        startedAt: 1_700_000_000_500,
        endedAt: 1_700_000_001_000,
        latencyMs: 500,
        model: {
          modelType: "PLANNER",
          provider: "anthropic",
          modelName: "claude-test",
          prompt: "short prompt",
          messages: [{ role: "user", content: "short prompt" }],
          response: "ok",
          toolCalls: [],
          usage: {
            promptTokens: 10,
            completionTokens: 2,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      },
    ],
  };
}

test("loadTrajectories: empty dir returns []", () => {
  const dir = mkTmpDir();
  const result = loadTrajectories(dir);
  assert.equal(result.length, 0);
});

test("loadTrajectories: missing dir returns []", () => {
  const dir = path.join(mkTmpDir(), "does-not-exist");
  const result = loadTrajectories(dir);
  assert.equal(result.length, 0);
});

test("loadTrajectories: skips non-trajectory JSON", () => {
  const dir = mkTmpDir();
  writeTrajectory(dir, "tj-good", fakeTrajectory("tj-good"));
  fs.writeFileSync(path.join(dir, "agent-1", "junk.json"), JSON.stringify({ hello: "world" }));
  const result = loadTrajectories(dir);
  assert.equal(result.length, 1);
  assert.equal(result[0].data.trajectoryId, "tj-good");
});

test("summarizeTrajectory aggregates step count and tokens", () => {
  const t = fakeTrajectory("tj-1");
  const s = summarizeTrajectory(t);
  assert.equal(s.id, "tj-1");
  assert.equal(s.stepCount, 2);
  // 100+20 + 10+2 = 132
  assert.equal(s.totalTokens, 132);
  assert.equal(s.status, "finished");
});

test("loadTrajectoryById finds by trajectoryId or filename", () => {
  const dir = mkTmpDir();
  writeTrajectory(dir, "tj-abc", fakeTrajectory("tj-abc"));
  const byId = loadTrajectoryById(dir, "tj-abc");
  assert.ok(byId, "should find by trajectoryId");
  assert.equal(byId.data.trajectoryId, "tj-abc");

  const missing = loadTrajectoryById(dir, "nope");
  assert.equal(missing, null);
});

test("aggregateStats sums tokens, tool calls, and finds longest", () => {
  const t = fakeTrajectory("tj-stats");
  const stats = aggregateStats(t);
  assert.equal(stats.modelCalls, 2);
  assert.equal(stats.promptTokens, 110);
  assert.equal(stats.completionTokens, 22);
  assert.equal(stats.cacheReadTokens, 50);
  assert.equal(stats.cacheCreationTokens, 10);
  assert.equal(stats.totalTokens, 132);
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.avgLatencyMs, 500);
  // First stage prompt is much longer than second.
  assert.ok(stats.longestPromptChars > 50, `expected > 50 got ${stats.longestPromptChars}`);
});

test("compactModelPrompt strips Loaded Plugins block", () => {
  const compacted = compactModelPrompt(SAMPLE_PROMPT_WITH_PLUGINS);
  assert.notEqual(compacted, SAMPLE_PROMPT_WITH_PLUGINS, "compaction should change the prompt");
  assert.match(compacted, /\[list omitted in compact mode\]/);
  // Original individual plugin lines should be gone.
  assert.doesNotMatch(compacted, /@elizaos\/plugin-foo/);
});

test("lineDiff produces non-empty diff for compacted Loaded Plugins prompt", () => {
  const compacted = compactModelPrompt(SAMPLE_PROMPT_WITH_PLUGINS);
  const diff = lineDiff(SAMPLE_PROMPT_WITH_PLUGINS, compacted);
  assert.ok(diff.length > 0);
  // Should contain at least one removed line and one added line.
  assert.match(diff, /^- /m);
  assert.match(diff, /^\+ /m);
});

test("approxTokens uses 4-chars-per-token heuristic", () => {
  assert.equal(approxTokens("aaaa"), 1);
  assert.equal(approxTokens("aaaaaaaa"), 2);
  assert.equal(approxTokens(""), 0);
});

test("assembledPromptFor prefers raw prompt then falls back to messages", () => {
  const withPrompt = assembledPromptFor({ prompt: "raw", messages: [{ role: "user", content: "msg" }] });
  assert.equal(withPrompt, "raw");
  const fromMessages = assembledPromptFor({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
    ],
  });
  assert.match(fromMessages, /\[system\]\nsys/);
  assert.match(fromMessages, /\[user\]\nu/);
});

test("main(list) on empty dir exits 0 and prints friendly message", async () => {
  const dir = mkTmpDir();
  // Capture stdout.
  const origWrite = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (chunk, ...rest) => {
    captured += typeof chunk === "string" ? chunk : chunk.toString();
    return origWrite(chunk, ...rest);
  };
  // console.log goes through stdout.write; we replace it briefly to avoid noise:
  const origLog = console.log;
  console.log = (...a) => { captured += `${a.join(" ")}\n`; };
  try {
    const code = await main(["list", "--dir", dir]);
    assert.equal(code, 0);
    assert.match(captured, /No trajector/i);
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }
});

test("main(show) prints trajectory and step contents", async () => {
  const dir = mkTmpDir();
  writeTrajectory(dir, "tj-show", fakeTrajectory("tj-show"));
  let captured = "";
  const origLog = console.log;
  console.log = (...a) => { captured += `${a.join(" ")}\n`; };
  try {
    const code = await main(["show", "tj-show", "--dir", dir]);
    assert.equal(code, 0);
    assert.match(captured, /tj-show/);
    assert.match(captured, /Step 0/);
    assert.match(captured, /REPLY/);
    assert.match(captured, /Hi back/);
  } finally {
    console.log = origLog;
  }
});

test("main(compaction-diff) reports reduction for plugin-listing prompt", async () => {
  const dir = mkTmpDir();
  writeTrajectory(dir, "tj-diff", fakeTrajectory("tj-diff"));
  let captured = "";
  const origLog = console.log;
  console.log = (...a) => { captured += `${a.join(" ")}\n`; };
  try {
    const code = await main(["compaction-diff", "tj-diff", "--dir", dir]);
    assert.equal(code, 0);
    assert.match(captured, /Compaction diff/);
    assert.match(captured, /Reduction:/);
    // Expect at least one removed line.
    assert.match(captured, /^- /m);
  } finally {
    console.log = origLog;
  }
});

test("main(stats) prints aggregate counts", async () => {
  const dir = mkTmpDir();
  writeTrajectory(dir, "tj-stats-cmd", fakeTrajectory("tj-stats-cmd"));
  let captured = "";
  const origLog = console.log;
  console.log = (...a) => { captured += `${a.join(" ")}\n`; };
  try {
    const code = await main(["stats", "tj-stats-cmd", "--dir", dir]);
    assert.equal(code, 0);
    assert.match(captured, /model calls:\s+2/);
    assert.match(captured, /total tokens:\s+132/);
    assert.match(captured, /tool calls:\s+1/);
  } finally {
    console.log = origLog;
  }
});

test("main(--help) prints usage", async () => {
  let captured = "";
  const origLog = console.log;
  console.log = (...a) => { captured += `${a.join(" ")}\n`; };
  try {
    const code = await main(["--help"]);
    assert.equal(code, 0);
    assert.match(captured, /Subcommands:/);
    assert.match(captured, /list/);
    assert.match(captured, /show/);
    assert.match(captured, /compaction-diff/);
    assert.match(captured, /stats/);
  } finally {
    console.log = origLog;
  }
});
