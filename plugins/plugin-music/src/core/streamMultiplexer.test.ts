import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { StreamMultiplexer } from "./streamMultiplexer";

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("StreamMultiplexer", () => {
  it("pauses and resumes the source for BLOCKING backpressure", async () => {
    const source = new PassThrough();
    const multiplexer = new StreamMultiplexer({
      policy: "BLOCKING",
      bufferSize: 4,
    });
    multiplexer.setSource(source);
    const consumer = multiplexer.addConsumer("slow");

    source.write(Buffer.alloc(16, 1));

    expect(source.isPaused()).toBe(true);
    expect(multiplexer.getConsumerStats("slow")).toEqual({
      droppedFrames: 0,
      totalFrames: 1,
    });

    const received: Buffer[] = [];
    consumer.on("data", (chunk: Buffer) => {
      received.push(chunk);
    });
    consumer.resume();
    await nextTick();

    expect(source.isPaused()).toBe(false);
    expect(Buffer.concat(received).length).toBe(16);

    multiplexer.destroy();
    source.destroy();
  });

  it("resumes a BLOCKING source when the slow consumer is removed", async () => {
    const source = new PassThrough();
    const multiplexer = new StreamMultiplexer({
      policy: "BLOCKING",
      bufferSize: 4,
    });
    multiplexer.setSource(source);
    multiplexer.addConsumer("removed");

    source.write(Buffer.alloc(16, 2));
    expect(source.isPaused()).toBe(true);

    multiplexer.removeConsumer("removed");
    await nextTick();

    expect(source.isPaused()).toBe(false);

    multiplexer.destroy();
    source.destroy();
  });
});
