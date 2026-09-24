/** Verifies complete native message reassembly and command boundary validation without browser mocks. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeNativeMessage,
  MAX_NATIVE_BYTES,
  NativeMessageAssembler,
  parseCommand,
} from "./protocol.mjs";

test("complete multilingual page content survives native framing", () => {
  const value = {
    type: "result",
    id: "request",
    result: { text: "最後🙂 full text ".repeat(120000) },
  };
  const frames = encodeNativeMessage(value);
  const receiver = new NativeMessageAssembler();
  for (const [index, frame] of frames.entries()) {
    assert.ok(
      new TextEncoder().encode(JSON.stringify(frame)).byteLength <
        MAX_NATIVE_BYTES,
    );
    const result = receiver.accept(frame);
    if (index < frames.length - 1) assert.equal(result, null);
    else assert.deepEqual(result, value);
  }
});
test("missing or repeated chunks cannot produce a request", () => {
  const frames = encodeNativeMessage({
    text: "x".repeat(MAX_NATIVE_BYTES * 2),
  });
  assert.throws(() => new NativeMessageAssembler().accept(frames[1]), /zero/);
  const receiver = new NativeMessageAssembler();
  assert.equal(receiver.accept(frames[0]), null);
  assert.throws(() => receiver.accept(frames[0]), /order/);
});
test("commands require exact tabs and reject script or credential URL dispatch", () => {
  assert.throws(
    () =>
      parseCommand({
        type: "command",
        id: "r1",
        command: { subaction: "click", selector: "button" },
      }),
    /tab ID/,
  );
  assert.throws(
    () =>
      parseCommand({
        type: "command",
        id: "r2",
        command: { subaction: "eval", script: "alert(1)" },
      }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      parseCommand({
        type: "command",
        id: "r3",
        command: { subaction: "open", url: "https://user:pass@example.com" },
      }),
    /credentials/,
  );
  assert.equal(
    parseCommand({
      type: "command",
      id: "r4",
      command: { subaction: "navigate", id: "12", url: "https://example.com" },
    }).command.id,
    "12",
  );
});
