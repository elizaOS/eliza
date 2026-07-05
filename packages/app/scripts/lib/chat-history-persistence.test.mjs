/**
 * Deterministic coverage for the chat-history relaunch-persistence verdict logic
 * (#13689). Fixtures are real-shaped `GET /api/conversations/:id/messages`
 * bodies (`{ messages: [{ role, text }] }`), not mocks of the parser — the
 * accept/reject logic is a pure function, so this proves the exact false-green
 * paths the issue warns about: a marker that never persisted, an empty thread
 * after relaunch (fresh/lost state dir), and stale residue from a prior run.
 *
 * Runs in the `packages/app` vitest lane (which collects `scripts/**\/*.test.mjs`)
 * so a regression fails CI. `node:assert` still throws on failure — a `node:test`
 * form would be loaded by vitest but collected as ZERO tests, an unenforced
 * green-by-skip (see android-assistant-verify-lib.test.mjs).
 *
 * Run: `bun run --cwd packages/app test -- scripts/lib/chat-history-persistence.test.mjs`
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import {
  assertMarkerSurvivedRelaunch,
  buildRelaunchMarker,
  ChatHistoryPersistenceError,
  extractMessageTexts,
  isRelaunchMarker,
  messageThreadContainsMarker,
  RELAUNCH_MARKER_PREFIX,
} from "./chat-history-persistence.mjs";

/** A real-shaped GET /messages body. */
function threadBody(texts) {
  return {
    messages: texts.map((text, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text,
    })),
  };
}

test("buildRelaunchMarker is unique per call and carries the prefix + platform", () => {
  const a = buildRelaunchMarker({ platform: "android", runId: "run1" });
  const b = buildRelaunchMarker({ platform: "android", runId: "run1" });
  assert.notEqual(a, b, "two markers from the same runId must still differ");
  assert.ok(a.startsWith(`${RELAUNCH_MARKER_PREFIX}-android-run1-`));
  assert.ok(isRelaunchMarker(a));
  assert.ok(isRelaunchMarker(b));
  // Deterministic when now+random are pinned (used for reproducible logs).
  const pinned = buildRelaunchMarker({
    platform: "ios",
    runId: "r",
    now: 1000,
    random: "abcd1234",
  });
  assert.equal(pinned, `${RELAUNCH_MARKER_PREFIX}-ios-r-1000-abcd1234`);
});

test("isRelaunchMarker rejects arbitrary user text", () => {
  assert.ok(!isRelaunchMarker("hello world"));
  assert.ok(!isRelaunchMarker(""));
  assert.ok(!isRelaunchMarker(undefined));
  assert.ok(!isRelaunchMarker(`prefixed-${RELAUNCH_MARKER_PREFIX}-x`));
});

test("extractMessageTexts returns ordered texts and treats {messages:[]} as a real empty thread", () => {
  assert.deepEqual(extractMessageTexts(threadBody(["hi", "yo"])), ["hi", "yo"]);
  assert.deepEqual(extractMessageTexts({ messages: [] }), []);
});

test("extractMessageTexts throws on a malformed body instead of fabricating an empty thread", () => {
  // A broken read (no messages key, wrong type, non-string text) is a broken
  // pipeline — never silently an empty thread.
  assert.throws(() => extractMessageTexts(null), ChatHistoryPersistenceError);
  assert.throws(() => extractMessageTexts({}), ChatHistoryPersistenceError);
  assert.throws(
    () => extractMessageTexts({ messages: "nope" }),
    ChatHistoryPersistenceError,
  );
  assert.throws(
    () => extractMessageTexts({ messages: [{ role: "user" }] }),
    /non-string text/,
  );
  assert.throws(
    () => extractMessageTexts([{ text: "x" }]),
    ChatHistoryPersistenceError,
  );
});

test("messageThreadContainsMarker matches only the exact marker", () => {
  const marker = buildRelaunchMarker({ platform: "android", runId: "hit" });
  assert.ok(messageThreadContainsMarker(threadBody(["noise", marker]), marker));
  assert.ok(
    !messageThreadContainsMarker(threadBody(["noise", "other"]), marker),
  );
});

test("assertMarkerSurvivedRelaunch passes when the marker is in both before and after threads", () => {
  const marker = buildRelaunchMarker({ platform: "android", runId: "ok" });
  const result = assertMarkerSurvivedRelaunch({
    marker,
    beforeBody: threadBody(["android smoke model works", marker]),
    afterBody: threadBody(["android smoke model works", marker, "reply"]),
  });
  assert.equal(result.survived, true);
  assert.equal(result.marker, marker);
  assert.equal(result.beforeCount, 2);
  assert.equal(result.afterCount, 3);
});

test("assertMarkerSurvivedRelaunch fails loudly when the thread is empty after relaunch (fresh/lost state dir)", () => {
  const marker = buildRelaunchMarker({ platform: "android", runId: "lost" });
  assert.throws(
    () =>
      assertMarkerSurvivedRelaunch({
        marker,
        beforeBody: threadBody([marker]),
        afterBody: { messages: [] },
      }),
    (err) => {
      assert.ok(err instanceof ChatHistoryPersistenceError);
      assert.equal(err.code, "MARKER_LOST_ON_RELAUNCH");
      assert.match(err.message, /did NOT survive relaunch/);
      return true;
    },
  );
});

test("assertMarkerSurvivedRelaunch fails when a stale prior-run message is present but the current marker is not", () => {
  const stale = buildRelaunchMarker({ platform: "android", runId: "prev" });
  const current = buildRelaunchMarker({ platform: "android", runId: "curr" });
  assert.throws(
    () =>
      assertMarkerSurvivedRelaunch({
        marker: current,
        // The send genuinely reached server truth this run...
        beforeBody: threadBody([current]),
        // ...but after relaunch only last run's residue remains — must fail.
        afterBody: threadBody([stale]),
      }),
    (err) => err.code === "MARKER_LOST_ON_RELAUNCH",
  );
});

test("assertMarkerSurvivedRelaunch refuses to pass when the marker never reached server truth (broken send)", () => {
  const marker = buildRelaunchMarker({ platform: "ios", runId: "nosend" });
  assert.throws(
    () =>
      assertMarkerSurvivedRelaunch({
        marker,
        beforeBody: threadBody(["some other message"]),
        afterBody: threadBody([marker]),
      }),
    (err) => {
      assert.equal(err.code, "MARKER_NOT_SENT");
      return true;
    },
  );
});

test("assertMarkerSurvivedRelaunch refuses a non-unique marker so a hardcoded string can't false-green", () => {
  assert.throws(
    () =>
      assertMarkerSurvivedRelaunch({
        marker: "hello",
        beforeBody: threadBody(["hello"]),
        afterBody: threadBody(["hello"]),
      }),
    (err) => err.code === "INVALID_MARKER",
  );
});

test("assertMarkerSurvivedRelaunch surfaces a malformed after-relaunch read as an error, not a pass", () => {
  const marker = buildRelaunchMarker({
    platform: "android",
    runId: "malformed",
  });
  assert.throws(
    () =>
      assertMarkerSurvivedRelaunch({
        marker,
        beforeBody: threadBody([marker]),
        afterBody: { error: "Failed to fetch messages" },
      }),
    (err) => err.code === "MISSING_MESSAGES",
  );
});
