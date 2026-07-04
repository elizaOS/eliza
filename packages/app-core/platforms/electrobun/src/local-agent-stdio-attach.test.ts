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
      path: "/api/x",
      method: "GET",
      headers: {},
      body: null,
    });
    endStdout();
    await expect(promise).rejects.toThrow(/stdout closed/);
    expect(getActiveLocalAgentDispatcher()).toBeNull();
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
