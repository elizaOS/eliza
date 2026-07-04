/**
 * Worker envelope tests cover request-id allocation and subprocess channel
 * message framing without launching the full remote plugin runtime.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  createRequestIdAllocator,
  createSubprocessChannel,
} from "./envelope.js";

type DataHandler = (chunk: string) => void;

class TestReadable {
  encoding: string | null = null;
  handlers = new Set<DataHandler>();

  setEncoding(encoding: string): void {
    this.encoding = encoding;
  }

  on(event: "data", handler: DataHandler): void {
    expect(event).toBe("data");
    this.handlers.add(handler);
  }

  off(event: "data", handler: DataHandler): void {
    expect(event).toBe("data");
    this.handlers.delete(handler);
  }

  emit(chunk: string): void {
    for (const handler of this.handlers) {
      handler(chunk);
    }
  }
}

class TestWritable {
  writes: string[] = [];

  write(data: string): void {
    this.writes.push(data);
  }
}

const originalProcess = globalThis.process;

function installTestProcess(): { stdin: TestReadable; stdout: TestWritable } {
  const stdin = new TestReadable();
  const stdout = new TestWritable();
  Object.defineProperty(globalThis, "process", {
    configurable: true,
    value: { stdin, stdout, env: {} },
  });
  return { stdin, stdout };
}

describe("createSubprocessChannel", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "process", {
      configurable: true,
      value: originalProcess,
    });
  });

  it("frames outbound messages as newline-delimited JSON", () => {
    const { stdout } = installTestProcess();
    const channel = createSubprocessChannel();

    channel.send({
      type: "init-complete",
    });

    expect(stdout.writes).toEqual([`{"type":"init-complete"}\n`]);
  });

  it("buffers chunked inbound messages and ignores malformed lines", () => {
    const { stdin } = installTestProcess();
    const channel = createSubprocessChannel();
    const received: unknown[] = [];
    channel.onMessage((message) => received.push(message));

    stdin.emit(`{"type":"host-r`);
    expect(received).toEqual([]);
    stdin.emit(`pc-result","requestId":1,"ok":true}\nnot-json\n`);
    stdin.emit(`\n{"type":"host-rpc-result","requestId":2,"ok":false}\n`);

    expect(received).toEqual([
      { type: "host-rpc-result", requestId: 1, ok: true },
      { type: "host-rpc-result", requestId: 2, ok: false },
    ]);
  });

  it("unsubscribes handlers and stops sending or receiving after close", () => {
    const { stdin, stdout } = installTestProcess();
    const channel = createSubprocessChannel();
    const received: unknown[] = [];
    const unsubscribe = channel.onMessage((message) => received.push(message));

    unsubscribe();
    stdin.emit(`{"type":"host-rpc-result","requestId":1,"ok":true}\n`);
    expect(received).toEqual([]);

    channel.onMessage((message) => received.push(message));
    channel.close();
    expect(stdin.handlers.size).toBe(0);

    stdin.emit(`{"type":"host-rpc-result","requestId":2,"ok":true}\n`);
    channel.send({ type: "init-complete" });

    expect(received).toEqual([]);
    expect(stdout.writes).toEqual([]);
  });
});

describe("createRequestIdAllocator", () => {
  it("allocates monotonically in an unsigned 32-bit namespace", () => {
    const alloc = createRequestIdAllocator();

    expect(alloc()).toBe(1);
    expect(alloc()).toBe(2);
  });
});
