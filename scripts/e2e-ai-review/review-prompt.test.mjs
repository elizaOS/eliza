/**
 * Unit tests for the pure prompt-assembly module: tail/head truncation caps,
 * trajectory and posthog digests (including explicit-invalid on garbage),
 * full prompt assembly, and reviewer-verdict validation. node:test, no I/O.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReviewPrompt,
  digestPosthogEvents,
  digestTrajectory,
  headSnippet,
  LOG_EXCERPT_CAP,
  parseReviewVerdict,
  SNIPPET_CAP,
  tailExcerpt,
} from "./review-prompt.mjs";

test("tailExcerpt keeps short text untouched", () => {
  assert.equal(tailExcerpt("hello"), "hello");
});

test("tailExcerpt keeps the tail and marks the omission", () => {
  const text = `${"a".repeat(LOG_EXCERPT_CAP)}TAIL`;
  const excerpt = tailExcerpt(text);
  assert.ok(excerpt.endsWith("TAIL"));
  assert.ok(excerpt.startsWith("[... 4 chars omitted; showing tail ...]"));
  // Marker aside, the retained payload respects the cap.
  const payload = excerpt.slice(excerpt.indexOf("\n") + 1);
  assert.equal(payload.length, LOG_EXCERPT_CAP);
});

test("headSnippet keeps the head and marks the omission", () => {
  const text = `HEAD${"b".repeat(SNIPPET_CAP)}`;
  const snippet = headSnippet(text);
  assert.ok(snippet.startsWith("HEAD"));
  assert.ok(snippet.includes("chars omitted"));
  assert.equal(snippet.slice(0, SNIPPET_CAP).length, SNIPPET_CAP);
});

test("digestTrajectory digests jsonl per LLM call with 2KB caps", () => {
  const longPrompt = "p".repeat(SNIPPET_CAP * 2);
  const jsonl = [
    JSON.stringify({
      model: "gpt-x",
      prompt: longPrompt,
      response: "short answer",
      toolCalls: [{ name: "SEND_MESSAGE" }, { function: { name: "search" } }],
    }),
    JSON.stringify({ modelType: "TEXT_LARGE", input: "hi", output: "yo" }),
  ].join("\n");
  const digest = digestTrajectory(jsonl);
  assert.equal(digest.ok, true);
  assert.equal(digest.callCount, 2);
  assert.ok(digest.text.includes("LLM call 1 (model: gpt-x)"));
  assert.ok(digest.text.includes("LLM call 2 (model: TEXT_LARGE)"));
  assert.ok(digest.text.includes("SEND_MESSAGE, search"));
  // The oversized prompt is head-truncated, not inlined whole.
  assert.ok(digest.text.includes("chars omitted"));
  assert.ok(!digest.text.includes(longPrompt));
});

test("digestTrajectory accepts a whole-file JSON array and wrapper objects", () => {
  const arrayForm = digestTrajectory(
    JSON.stringify([{ model: "m1", prompt: "a", response: "b" }]),
  );
  assert.equal(arrayForm.ok, true);
  assert.equal(arrayForm.callCount, 1);
  const wrapperForm = digestTrajectory(
    JSON.stringify({ calls: [{ model: "m2", prompt: "a", response: "b" }] }),
  );
  assert.equal(wrapperForm.ok, true);
  assert.ok(wrapperForm.text.includes("model: m2"));
});

test("digestTrajectory reports invalid input explicitly", () => {
  assert.equal(digestTrajectory("").ok, false);
  assert.equal(digestTrajectory("complete garbage\nmore garbage").ok, false);
  assert.equal(digestTrajectory('"just a string"').ok, false);
});

test("digestPosthogEvents builds a histogram and surfaces notable events", () => {
  const events = [
    { event: "$pageview" },
    { event: "$pageview" },
    { event: "chat_message_sent" },
    { event: "$exception", properties: { message: "boom" } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  const digest = digestPosthogEvents(events);
  assert.equal(digest.ok, true);
  assert.equal(digest.eventCount, 4);
  assert.ok(digest.text.includes("2x $pageview"));
  assert.ok(digest.text.includes("1x chat_message_sent"));
  assert.ok(digest.text.includes("notable events:"));
  assert.ok(digest.text.includes("boom"));
});

test("digestPosthogEvents reports invalid input explicitly", () => {
  assert.equal(digestPosthogEvents("not events").ok, false);
});

const manifest = {
  schema: "elizaos.e2e.test/1",
  id: "app:chat.spec.ts:sends a message",
  runId: "run-1",
  lane: "app",
  project: "chromium",
  file: "chat.spec.ts",
  title: "sends a message",
  status: "failed",
  durationMs: 1234,
  startedAt: "2026-07-09T00:00:00.000Z",
  finishedAt: "2026-07-09T00:00:01.234Z",
  artifacts: [{ kind: "console-log", path: "logs/console.log" }],
};

test("buildReviewPrompt includes manifest, capped logs, digests, and the contract", () => {
  const prompt = buildReviewPrompt(manifest, {
    consoleLog: `${"x".repeat(LOG_EXCERPT_CAP + 100)}console-tail-sentinel`,
    networkLog: "GET /api/agents 200",
    ocrText: "Send a message",
    trajectoryRaw: JSON.stringify({ model: "m", prompt: "p", response: "r" }),
    posthogEventsRaw: JSON.stringify({ event: "$pageview" }),
    screenshotPaths: ["/abs/shot-1.png"],
    videoPaths: ["/abs/video.mp4"],
  });
  assert.ok(prompt.includes("app:chat.spec.ts:sends a message"));
  assert.ok(prompt.includes("console-tail-sentinel"));
  assert.ok(prompt.includes("chars omitted; showing tail"));
  assert.ok(prompt.includes("GET /api/agents 200"));
  // Server log was not provided: explicit "(not captured)", never silently absent.
  assert.ok(prompt.includes("Server log (tail excerpt)\n(not captured)"));
  assert.ok(prompt.includes("model: m"));
  assert.ok(prompt.includes("1x $pageview"));
  assert.ok(prompt.includes("/abs/shot-1.png"));
  assert.ok(prompt.includes("/abs/video.mp4"));
  assert.ok(
    prompt.includes('"verdict": "pass" | "fail" | "flaky" | "needs-eyeball"'),
  );
});

test("buildReviewPrompt marks an unparseable trajectory instead of hiding it", () => {
  const prompt = buildReviewPrompt(manifest, { trajectoryRaw: "garbage" });
  assert.ok(prompt.includes("trajectory artifact present but unparseable"));
});

test("parseReviewVerdict accepts a full verdict and normalizes optionals", () => {
  const parsed = parseReviewVerdict({
    verdict: "fail",
    confidence: 0.8,
    findings: [
      {
        severity: "blocker",
        area: "app",
        summary: "send button dead",
        evidence: "console TypeError",
        suggestedFix: "guard null ref",
        files: ["packages/ui/src/x.tsx"],
      },
    ],
    notes: "clear regression",
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verdict.verdict, "fail");
  assert.equal(parsed.verdict.findings[0].files[0], "packages/ui/src/x.tsx");
});

test("parseReviewVerdict tolerates omitted findings/notes on a pass", () => {
  const parsed = parseReviewVerdict({ verdict: "pass", confidence: 1 });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.verdict.findings, []);
  assert.equal(parsed.verdict.notes, "");
});

test("parseReviewVerdict rejects bad shapes with explicit reasons", () => {
  assert.equal(parseReviewVerdict(null).ok, false);
  assert.equal(
    parseReviewVerdict({ verdict: "maybe", confidence: 0.5 }).ok,
    false,
  );
  assert.equal(
    parseReviewVerdict({ verdict: "pass", confidence: 2 }).ok,
    false,
  );
  assert.equal(
    parseReviewVerdict({ verdict: "pass", confidence: "high" }).ok,
    false,
  );
  assert.equal(
    parseReviewVerdict({
      verdict: "fail",
      confidence: 0.5,
      findings: [{ severity: "catastrophic", area: "app", summary: "x" }],
    }).ok,
    false,
  );
  assert.equal(
    parseReviewVerdict({
      verdict: "fail",
      confidence: 0.5,
      findings: [{ severity: "major", area: "app", summary: "  " }],
    }).ok,
    false,
  );
});
