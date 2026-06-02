import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { StreamMultiplexer } from "./streamMultiplexer";

describe("StreamMultiplexer BLOCKING backpressure", () => {
  it("pauses the source when a blocking consumer backpressures and resumes on drain", () => {
    const source = new Readable({ read() {} });
    const multiplexer = new StreamMultiplexer({ policy: "BLOCKING" });
    multiplexer.setSource(source);
    source.resume();

    const consumer = multiplexer.addConsumer("recorder");
    vi.spyOn(consumer, "write").mockReturnValue(false);

    source.emit("data", Buffer.from("audio"));

    expect(source.isPaused()).toBe(true);

    consumer.emit("drain");

    expect(source.isPaused()).toBe(false);
    multiplexer.destroy();
  });

  it("waits for all blocked consumers before resuming the source", () => {
    const source = new Readable({ read() {} });
    const multiplexer = new StreamMultiplexer({ policy: "BLOCKING" });
    multiplexer.setSource(source);
    source.resume();

    const firstConsumer = multiplexer.addConsumer("recorder-a");
    const secondConsumer = multiplexer.addConsumer("recorder-b");
    vi.spyOn(firstConsumer, "write").mockReturnValue(false);
    vi.spyOn(secondConsumer, "write").mockReturnValue(false);

    source.emit("data", Buffer.from("audio"));

    firstConsumer.emit("drain");
    expect(source.isPaused()).toBe(true);

    secondConsumer.emit("drain");
    expect(source.isPaused()).toBe(false);
    multiplexer.destroy();
  });
});
