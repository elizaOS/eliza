/**
 * Unit tests for the pure PostHog payload decode + per-test routing layer the
 * e2e sink is built on (`posthog-payload.mjs`). Fully deterministic node:test
 * suite — synthetic payloads only, no server, no network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  createEventRouter,
  decodePosthogBody,
  normalizeEvents,
} from "./posthog-payload.mjs";

const EVENTS = [
  { event: "$pageview", properties: { eliza_test_id: "lane:file.ts:t1" } },
  { event: "click", properties: { eliza_test_id: "lane:file.ts:t1" } },
];

test("decodes a plain JSON body", () => {
  const result = decodePosthogBody(Buffer.from(JSON.stringify(EVENTS)), {
    contentType: "application/json",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, EVENTS);
});

test("decodes an urlencoded data= base64 body", () => {
  const base64 = Buffer.from(JSON.stringify(EVENTS)).toString("base64");
  const body = `data=${encodeURIComponent(base64)}&compression=base64`;
  const result = decodePosthogBody(Buffer.from(body), {
    contentType: "application/x-www-form-urlencoded",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, EVENTS);
});

test("decodes an urlencoded data= body carrying raw JSON", () => {
  const body = `data=${encodeURIComponent(JSON.stringify(EVENTS))}`;
  const result = decodePosthogBody(Buffer.from(body), { contentType: "" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, EVENTS);
});

test("decodes a gzip-js body via the compression param", () => {
  const result = decodePosthogBody(gzipSync(JSON.stringify(EVENTS)), {
    compression: "gzip-js",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, EVENTS);
});

test("decodes a gzip body via magic bytes when the param is missing", () => {
  const result = decodePosthogBody(gzipSync(JSON.stringify(EVENTS)), {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, EVENTS);
});

test("rejects malformed input explicitly", () => {
  assert.equal(decodePosthogBody(Buffer.from("not json"), {}).ok, false);
  assert.equal(decodePosthogBody(Buffer.from(""), {}).ok, false);
  assert.equal(
    decodePosthogBody(Buffer.from("other=1"), {
      contentType: "application/x-www-form-urlencoded",
    }).ok,
    false,
  );
  // Truncated gzip stream must not fall through to a text parse.
  assert.equal(
    decodePosthogBody(gzipSync(JSON.stringify(EVENTS)).subarray(0, 5), {
      compression: "gzip-js",
    }).ok,
    false,
  );
});

test("normalizeEvents flattens arrays, batch envelopes, and single events", () => {
  assert.deepEqual(normalizeEvents(EVENTS), EVENTS);
  assert.deepEqual(normalizeEvents({ batch: EVENTS }), EVENTS);
  assert.deepEqual(normalizeEvents(EVENTS[0]), [EVENTS[0]]);
  assert.deepEqual(normalizeEvents(["junk", 42, null, EVENTS[0]]), [EVENTS[0]]);
});

test("routes $snapshot events to the snapshots stream", () => {
  const router = createEventRouter();
  const routed = router.route({
    event: "$snapshot",
    properties: { eliza_test_id: "lane:spec.ts:replay", $snapshot_data: [] },
  });
  assert.deepEqual(routed, { testId: "lane:spec.ts:replay", stream: "snapshots" });
});

test("routes events without a test id to unassigned", () => {
  const router = createEventRouter();
  assert.deepEqual(router.route({ event: "$pageview", properties: {} }), {
    testId: null,
    stream: "events",
  });
  assert.deepEqual(router.route({ event: "$snapshot" }), {
    testId: null,
    stream: "snapshots",
  });
});

test("associates later id-less events through $session_id and distinct_id", () => {
  const router = createEventRouter();
  router.route({
    event: "$pageview",
    properties: {
      eliza_test_id: "lane:spec.ts:assoc",
      $session_id: "s-1",
      distinct_id: "d-1",
    },
  });
  assert.deepEqual(
    router.route({ event: "$snapshot", properties: { $session_id: "s-1" } }),
    { testId: "lane:spec.ts:assoc", stream: "snapshots" },
  );
  assert.deepEqual(
    router.route({ event: "beacon", distinct_id: "d-1", properties: {} }),
    { testId: "lane:spec.ts:assoc", stream: "events" },
  );
  // An unrelated session stays unassigned.
  assert.deepEqual(
    router.route({ event: "$snapshot", properties: { $session_id: "s-2" } }),
    { testId: null, stream: "snapshots" },
  );
});
