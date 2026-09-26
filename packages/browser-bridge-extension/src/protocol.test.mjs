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

test("acknowledged chunks bound Binder traffic and preserve complete multilingual results", async () => {
  const { NativeMessageSender, acknowledgeNativeChunk } = await import(
    "./protocol.mjs"
  );
  const assembler = new NativeMessageAssembler();
  let inFlight = 0;
  let highWater = 0;
  let received;
  const sender = new NativeMessageSender((frame) => {
    inFlight++;
    highWater = Math.max(highWater, inFlight);
    // An independent transport callback, not the command queue which awaits send.
    setImmediate(() => {
      received = assembler.accept(frame) ?? received;
      inFlight--;
      acknowledgeNativeChunk(frame, (ack) => sender.acceptAcknowledgement(ack));
    });
  });
  const value = { type: "result", text: "全文🙂最後".repeat(100000) };
  await sender.send(value);
  assert.equal(highWater, 1);
  assert.equal(inFlight, 0);
  assert.deepEqual(received, value);
});

test("a disconnected transfer rejects without sending or replaying remaining chunks", async () => {
  const { NativeMessageSender } = await import("./protocol.mjs");
  let sent = 0;
  const sender = new NativeMessageSender(() => {
    sent++;
  });
  const sending = sender.send({ text: "x".repeat(MAX_NATIVE_BYTES * 2) });
  assert.equal(sent, 1);
  sender.close(new Error("disconnected"));
  await assert.rejects(sending, /disconnected/);
  await assert.rejects(sender.send({ text: "no replay" }), /disconnected/);
  assert.equal(sent, 1);
});
