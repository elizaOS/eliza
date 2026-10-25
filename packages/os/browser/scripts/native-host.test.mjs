/** Exercises native-message streaming with split frames, Unicode, invalid lengths and incomplete input. */
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { NativeFrameTransform } from "./native-host.mjs";

function frame(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}

test("relay preserves split and coalesced Unicode frames exactly", async () => {
  const input = Buffer.concat([
    frame({ text: "🦊 日本語" }),
    frame({ id: "second", ok: true }),
  ]);
  const received = [];
  await pipeline(
    Readable.from([
      input.subarray(0, 2),
      input.subarray(2, 7),
      input.subarray(7),
    ]),
    new NativeFrameTransform(),
    new Writable({
      write(bytes, _, done) {
        received.push(bytes);
        done();
      },
    }),
  );
  assert.deepEqual(Buffer.concat(received), input);
});

test("rejects oversized frame before forwarding its partial contents", async () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(65537);
  const received = [];
  await assert.rejects(
    pipeline(
      Readable.from([header]),
      new NativeFrameTransform(),
      new Writable({
        write(bytes, _, done) {
          received.push(bytes);
          done();
        },
      }),
    ),
    /FRAME_TOO_LARGE/,
  );
  assert.equal(received.length, 0);
});

test("rejects incomplete frame", async () => {
  const bytes = frame({ text: "complete" });
  await assert.rejects(
    pipeline(
      Readable.from([bytes.subarray(0, bytes.length - 1)]),
      new NativeFrameTransform(),
      new Writable({
        write(_, __, done) {
          done();
        },
      }),
    ),
    /FRAME_INCOMPLETE/,
  );
});
