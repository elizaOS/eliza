import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMarkerSurvivedRelaunch,
  buildRelaunchMarker,
  ChatHistoryPersistenceError,
  extractMessageTexts,
  isRelaunchMarker,
  RELAUNCH_MARKER_PREFIX,
} from "./chat-history-persistence.mjs";

function threadBody(texts) {
  return {
    messages: texts.map((text, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text,
    })),
  };
}

test("unique markers require full generated shape", () => {
  const marker = buildRelaunchMarker({
    platform: "android",
    runId: "conv_123",
    now: 1783280000000,
    random: "abcd1234",
  });
  assert.equal(
    marker,
    `${RELAUNCH_MARKER_PREFIX}-android-conv_123-1783280000000-abcd1234`,
  );
  assert.equal(isRelaunchMarker(marker), true);
  assert.equal(isRelaunchMarker(`${RELAUNCH_MARKER_PREFIX}-hardcoded`), false);
  assert.equal(
    isRelaunchMarker(
      buildRelaunchMarker({
        platform: "android local",
        runId: "conversation:123",
        now: 1783280000000,
        random: "abcd1234",
      }),
    ),
    true,
  );
});

test("extractMessageTexts parses real-shaped message bodies and rejects malformed reads", () => {
  assert.deepEqual(extractMessageTexts(threadBody(["one", "two"])), [
    "one",
    "two",
  ]);
  assert.deepEqual(extractMessageTexts({ messages: [] }), []);
  assert.throws(() => extractMessageTexts({}), ChatHistoryPersistenceError);
  assert.throws(
    () => extractMessageTexts({ messages: [{ role: "user" }] }),
    /non-string text/,
  );
});

test("assertMarkerSurvivedRelaunch accepts only current marker before and after relaunch", () => {
  const marker = buildRelaunchMarker({
    platform: "android",
    runId: "survived",
  });
  assert.equal(
    assertMarkerSurvivedRelaunch({
      marker,
      beforeBody: threadBody([marker]),
      afterBody: threadBody(["reply", marker]),
    }).survived,
    true,
  );

  assert.throws(
    () =>
      assertMarkerSurvivedRelaunch({
        marker,
        beforeBody: threadBody([marker]),
        afterBody: { messages: [] },
      }),
    (error) => error.code === "MARKER_LOST_ON_RELAUNCH",
  );
});
