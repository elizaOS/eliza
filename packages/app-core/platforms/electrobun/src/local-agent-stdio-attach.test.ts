/** Exercises local agent stdio attach behavior with deterministic app-core test fixtures. */
import { afterEach, describe, expect, it } from "vitest";
import {
  getActiveLocalAgentDispatcher,
  requireActiveLocalAgentDispatcher,
  setActiveLocalAgentDispatcher,
} from "./local-agent-dispatcher-registry";
import {
  attachLocalAgentStdioBridge,
  type LocalAgentChildStdio,
} from "./local-agent-stdio-attach";

/**
 * Tests the child-stdio → dispatcher attachment + the process-wide dispatcher
 * registry (#12355): a request written to the fake child's stdin is answered by
 * feeding a response frame from its stdout, and detach clears the registry and
 * rejects in-flight requests. No spawned process — the fake child is a controlled
 * async stdout queue.
 */

afterEach(() => {
  setActiveLocalAgentDispatcher(null);
});

/** A controllable fake child: captured stdin lines + a pushable stdout queue. */
function makeFakeChild(): {
  child: LocalAgentChildStdio;
  stdinLines: string[];
  pushStdout: (line: string) => void;
  endStdout: () => void;
} {
  const stdinLines: string[] = [];
  const queue: string[] = [];
  const waiters: Array<(v: IteratorResult<string>) => void> = [];
  let ended = false;

  const pushStdout = (line: string): void => {
    const waiter = waiters.shift();
    if (waiter) waiter({ value: line, done: false });
    else queue.push(line);
  };
  const endStdout = (): void => {
    ended = true;
    const waiter = waiters.shift();
    if (waiter) waiter({ value: undefined as never, done: true });
  };

  const stdout: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          if (queue.length > 0) {
            return Promise.resolve({
              value: queue.shift() as string,
              done: false,
            });
          }
          if (ended)
            return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  return {
    child: { stdin: { write: (line) => stdinLines.push(line) }, stdout },
    stdinLines,
    pushStdout,
    endStdout,
  };
}

describe("attachLocalAgentStdioBridge", () => {
  it("registers the dispatcher and round-trips a request via stdin/stdout", async () => {
    const { child, stdinLines, pushStdout } = makeFakeChild();
    const { detach } = attachLocalAgentStdioBridge(child);

    expect(getActiveLocalAgentDispatcher()).not.toBeNull();

    const promise = requireActiveLocalAgentDispatcher().request({
      requestId: "attach-health",
      path: "/api/health",
      method: "GET",
      headers: {},
      body: null,
    });

    // Wait a tick for the frame to be written.
    await Promise.resolve();
    expect(stdinLines).toHaveLength(1);
    const sent = JSON.parse(stdinLines[0]);
    expect(sent.payload.path).toBe("/api/health");

    pushStdout(
      JSON.stringify({
        id: sent.id,
        ok: true,
        result: { status: 200, body: "OK" },
      }),
    );

    await expect(promise).resolves.toEqual({ status: 200, body: "OK" });
    detach("test done");
    expect(getActiveLocalAgentDispatcher()).toBeNull();
  });

  it("detach rejects in-flight requests and clears the registry", async () => {
    const { child } = makeFakeChild();
    const { detach } = attachLocalAgentStdioBridge(child);
    const dispatcher = requireActiveLocalAgentDispatcher();
    const promise = dispatcher.request({
      requestId: "attach-detach",
      path: "/api/x",
      method: "GET",
      headers: {},
      body: null,
    });
    detach("agent exited");
    await expect(promise).rejects.toThrow(/agent exited/);
    expect(getActiveLocalAgentDispatcher()).toBeNull();
  });

  it("tears down when the child stdout closes", async () => {
    const { child, endStdout } = makeFakeChild();
    const { dispatcher } = attachLocalAgentStdioBridge(child);
    const promise = dispatcher.request({
      requestId: "attach-stdout-close",
      path: "/api/x",
      method: "GET",
      headers: {},
      body: null,
    });
    endStdout();
    await expect(promise).rejects.toThrow(/stdout closed/);
    expect(getActiveLocalAgentDispatcher()).toBeNull();
  });

  it("round-trips an incremental stream through the attached child", async () => {
    const { child, stdinLines, pushStdout } = makeFakeChild();
    const { dispatcher, detach } = attachLocalAgentStdioBridge(child);
    const chunks: string[] = [];
    const ended: Array<string | undefined> = [];
    let resolveEnd!: () => void;
    const streamEnded = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });

    const head = dispatcher.requestStream(
      {
        requestId: "attach-stream",
        path: "/api/conversations/c/messages/stream",
        method: "POST",
        headers: { accept: "text/event-stream" },
        body: "{}",
      },
      {
        onChunk: (chunk) => chunks.push(chunk),
        onEnd: (error) => {
          ended.push(error);
          resolveEnd();
        },
      },
    );
    expect(JSON.parse(stdinLines[0])).toMatchObject({
      id: "attach-stream",
      method: "local_agent_stream_request",
      stream: true,
    });

    pushStdout(
      JSON.stringify({
        id: "attach-stream",
        stream: "response",
        status: 200,
      }),
    );
    await expect(head).resolves.toMatchObject({ status: 200 });
    pushStdout(
      JSON.stringify({
        id: "attach-stream",
        stream: "chunk",
        dataBase64: Buffer.from("data: hello\n\n").toString("base64"),
      }),
    );
    pushStdout(JSON.stringify({ id: "attach-stream", stream: "complete" }));
    await streamEnded;

    expect(chunks).toEqual(["data: hello\n\n"]);
    expect(ended).toEqual([undefined]);
    detach("test done");
  });
});

describe("local-agent dispatcher registry", () => {
  it("requireActiveLocalAgentDispatcher throws with a clear message when unset", () => {
    setActiveLocalAgentDispatcher(null);
    expect(() => requireActiveLocalAgentDispatcher()).toThrow(
      /no local-agent IPC dispatcher is attached/,
    );
  });
});
