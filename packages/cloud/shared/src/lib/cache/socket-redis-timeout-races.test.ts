import { describe, expect, test } from "bun:test";
import { createSocketRedisForTests, type SocketRedisTestTransport } from "./socket-redis";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const encoder = new TextEncoder();

function bulk(value: string): ReadableStreamReadResult<Uint8Array> {
  return {
    done: false,
    value: encoder.encode(`$${encoder.encode(value).byteLength}\r\n${value}\r\n`),
  };
}

describe("SocketRedis timeout ownership", () => {
  test("a late timed-out operation stays on its retired reader instead of consuming its successor", async () => {
    const firstWriteStarted = deferred<void>();
    const releaseFirstWrite = deferred<void>();
    const firstReaderCalled = deferred<void>();
    const successorOpened = deferred<void>();
    const successorWriteStarted = deferred<void>();
    const releaseSuccessorWrite = deferred<void>();
    let opens = 0;
    let firstReads = 0;
    let successorReads = 0;

    const firstTransport: SocketRedisTestTransport = {
      writer: {
        write() {
          firstWriteStarted.resolve();
          return releaseFirstWrite.promise;
        },
        async abort() {},
      },
      reader: {
        read() {
          firstReads += 1;
          firstReaderCalled.resolve();
          return Promise.reject(new Error("retired reader"));
        },
        async cancel() {},
      },
      async close() {},
    };

    const successorTransport: SocketRedisTestTransport = {
      writer: {
        write() {
          successorWriteStarted.resolve();
          return releaseSuccessorWrite.promise;
        },
        async abort() {},
      },
      reader: {
        async read() {
          successorReads += 1;
          return bulk("successor");
        },
        async cancel() {},
      },
      async close() {},
    };

    const redis = createSocketRedisForTests("redis://example.test:6379", {
      async openTransport() {
        opens += 1;
        if (opens === 1) return firstTransport;
        successorOpened.resolve();
        return successorTransport;
      },
      operationTimeoutMs: 20,
      closeTimeoutMs: 5,
    });

    const first = redis.get("first");
    await firstWriteStarted.promise;
    await expect(first).rejects.toThrow("timed out after 20ms");

    const second = redis.get<string>("second");
    await successorOpened.promise;
    await successorWriteStarted.promise;

    // The loser resumes only after its timeout teardown and after the
    // successor has published its own state. It must still use state #1.
    releaseFirstWrite.resolve();
    const lateReader = await Promise.race([
      firstReaderCalled.promise.then(() => "retired" as const),
      new Promise<"missing">((resolve) => setTimeout(() => resolve("missing"), 100)),
    ]);
    expect(lateReader).toBe("retired");

    releaseSuccessorWrite.resolve();
    expect(await second).toBe("successor");
    expect(firstReads).toBe(1);
    expect(successorReads).toBe(1);
    expect(opens).toBe(2);

    await redis.quit();
  });

  test("a delayed stale connection cannot publish over a successor", async () => {
    const firstOpenStarted = deferred<void>();
    const releaseFirstOpen = deferred<SocketRedisTestTransport>();
    const staleClosed = deferred<void>();
    let opens = 0;
    let staleWrites = 0;
    let staleReads = 0;
    let successorWrites = 0;
    let successorReads = 0;

    const staleTransport: SocketRedisTestTransport = {
      writer: {
        async write() {
          staleWrites += 1;
        },
        async abort() {},
      },
      reader: {
        async read() {
          staleReads += 1;
          return bulk("stale");
        },
        async cancel() {},
      },
      async close() {
        staleClosed.resolve();
      },
    };

    const successorTransport: SocketRedisTestTransport = {
      writer: {
        async write() {
          successorWrites += 1;
        },
        async abort() {},
      },
      reader: {
        async read() {
          successorReads += 1;
          return bulk("successor");
        },
        async cancel() {},
      },
      async close() {},
    };

    const redis = createSocketRedisForTests("redis://example.test:6379", {
      async openTransport() {
        opens += 1;
        if (opens === 1) {
          firstOpenStarted.resolve();
          return await releaseFirstOpen.promise;
        }
        return successorTransport;
      },
      operationTimeoutMs: 20,
      closeTimeoutMs: 5,
    });

    const first = redis.get("first");
    await firstOpenStarted.promise;
    await expect(first).rejects.toThrow("timed out after 20ms");

    expect(await redis.get<string>("second")).toBe("successor");
    expect(opens).toBe(2);

    // Resolve the original open after the successor is live. The ownership
    // check must close it locally without writing, reading, or publishing it.
    releaseFirstOpen.resolve(staleTransport);
    await staleClosed.promise;

    expect(await redis.get<string>("third")).toBe("successor");
    expect(opens).toBe(2);
    expect(staleWrites).toBe(0);
    expect(staleReads).toBe(0);
    expect(successorWrites).toBe(2);
    expect(successorReads).toBe(2);

    await redis.quit();
  });
});
