/**
 * Wire-level test for the SSE writers used by the streaming chat endpoint.
 *
 * Asserts the byte-for-byte format of SSE frames produced by `initSse`,
 * `writeChatTokenSse`, and `writeSseJson`. Without this, regressions in the
 * frame shape (missing `\n\n`, JSON envelope fields, ordering) would only be
 * caught by full e2e runs.
 */
import type { ServerResponse } from "node:http";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  initSse,
  writeChatTokenSse,
  writeSse,
  writeSseData,
  writeSseJson,
} from "../chat-routes.js";

interface CapturedHead {
  status: number;
  headers: Record<string, string>;
}

interface MockResponse {
  res: ServerResponse;
  head: CapturedHead | null;
  writes: string[];
  ended: boolean;
}

function createMockResponse(): MockResponse {
  const writes: string[] = [];
  let head: CapturedHead | null = null;
  let ended = false;
  let writableEnded = false;
  const destroyed = false;

  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      head = { status, headers: headers ?? {} };
      return res;
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    end() {
      ended = true;
      writableEnded = true;
    },
    get writableEnded() {
      return writableEnded;
    },
    get destroyed() {
      return destroyed;
    },
  } as unknown as ServerResponse;

  return {
    res,
    get head() {
      return head;
    },
    get writes() {
      return writes;
    },
    get ended() {
      return ended;
    },
  } as MockResponse;
}

interface ParsedFrame {
  raw: string;
  payload: { type: string; [key: string]: unknown };
}

function parseFrames(writes: string[]): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  for (const write of writes) {
    const trimmed = write.endsWith("\n\n") ? write.slice(0, -2) : write;
    if (!trimmed.startsWith("data: ")) continue;
    const json = trimmed.slice("data: ".length);
    frames.push({
      raw: write,
      payload: JSON.parse(json) as ParsedFrame["payload"],
    });
  }
  return frames;
}

describe("SSE wire format", () => {
  it("initSse writes correct headers", () => {
    const mock = createMockResponse();
    initSse(mock.res);

    expect(mock.head?.status).toBe(200);
    expect(mock.head?.headers["Content-Type"]).toBe("text/event-stream");
    expect(mock.head?.headers["Cache-Control"]).toBe("no-cache, no-transform");
    expect(mock.head?.headers.Connection).toBe("keep-alive");
    expect(mock.head?.headers["X-Accel-Buffering"]).toBe("no");
  });

  it("writeChatTokenSse emits a `token` frame with text + fullText", () => {
    const mock = createMockResponse();
    writeChatTokenSse(mock.res, "Hello", "Hello");

    expect(mock.writes).toHaveLength(1);
    const frame = mock.writes[0];
    expect(frame.startsWith("data: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);

    const payload = JSON.parse(frame.slice(6, -2)) as Record<string, unknown>;
    expect(payload).toEqual({
      type: "token",
      text: "Hello",
      fullText: "Hello",
    });
  });

  it("emits N token frames followed by a single done frame, in order", () => {
    const mock = createMockResponse();
    initSse(mock.res);

    const tokens = ["Hel", "lo ", "there", "!"];
    let acc = "";
    for (const token of tokens) {
      acc += token;
      writeChatTokenSse(mock.res, token, acc);
    }
    writeSseJson(mock.res, { type: "done", fullText: acc, agentName: "Bot" });

    const frames = parseFrames(mock.writes);
    // 4 token frames + 1 done frame.
    expect(frames).toHaveLength(tokens.length + 1);

    for (let i = 0; i < tokens.length; i += 1) {
      expect(frames[i].payload.type).toBe("token");
      expect(frames[i].payload.text).toBe(tokens[i]);
    }
    expect(frames[tokens.length].payload.type).toBe("done");
    expect(frames[tokens.length].payload.fullText).toBe(acc);
  });

  it("carries an optional thought field on the done frame", () => {
    const mock = createMockResponse();
    initSse(mock.res);

    writeChatTokenSse(mock.res, "Yes.", "Yes.");
    writeSseJson(mock.res, {
      type: "done",
      fullText: "Yes.",
      agentName: "Bot",
      thought: "Short binary question; a one-word answer suffices.",
    });

    const frames = parseFrames(mock.writes);
    const done = frames.at(-1);
    expect(done?.payload.type).toBe("done");
    // Reasoning rides the additive `thought` field; the visible reply stays
    // in `fullText` and is never polluted by the thought.
    expect(done?.payload.thought).toBe(
      "Short binary question; a one-word answer suffices.",
    );
    expect(done?.payload.fullText).toBe("Yes.");
  });

  it("does not buffer: each writeChatTokenSse produces exactly one write call", () => {
    const mock = createMockResponse();
    initSse(mock.res);

    writeChatTokenSse(mock.res, "a", "a");
    expect(mock.writes).toHaveLength(1);

    writeChatTokenSse(mock.res, "b", "ab");
    expect(mock.writes).toHaveLength(2);

    writeChatTokenSse(mock.res, "c", "abc");
    expect(mock.writes).toHaveLength(3);
  });

  it("writeSse refuses to write after the response is ended", () => {
    const mock = createMockResponse();
    initSse(mock.res);
    writeSse(mock.res, { type: "token", text: "x", fullText: "x" });
    expect(mock.writes).toHaveLength(1);

    mock.res.end();
    writeSse(mock.res, { type: "token", text: "y", fullText: "xy" });
    // Still only the one pre-end write.
    expect(mock.writes).toHaveLength(1);
  });

  it("writeSseJson includes an event line when provided", () => {
    const mock = createMockResponse();
    writeSseJson(mock.res, { ok: true }, "ping");
    // Three writes: the `event:` line, the `data:` line, and the blank
    // terminator line.
    expect(mock.writes.join("")).toContain("event: ping\n");
    expect(mock.writes.join("")).toContain('data: {"ok":true}\n\n');
  });

  it("writeSseData frames multiline raw data without creating bare lines", () => {
    const mock = createMockResponse();
    writeSseData(mock.res, "alpha\nbeta\r\ngamma\rdone", "message");

    expect(mock.writes.join("")).toBe(
      "event: message\n" +
        "data: alpha\n" +
        "data: beta\n" +
        "data: gamma\n" +
        "data: done\n" +
        "\n",
    );
  });

  it("writeSseData drops event names that could inject SSE fields", () => {
    const mock = createMockResponse();
    writeSseData(mock.res, "payload", "token\nid: attacker");

    expect(mock.writes.join("")).toBe("data: payload\n\n");
  });

  it("writeSseJson preserves hostile strings as JSON data, not SSE syntax", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (text, eventName) => {
        const mock = createMockResponse();
        writeSseJson(mock.res, { text }, eventName);
        const wire = mock.writes.join("");

        expect(wire.endsWith("\n\n")).toBe(true);
        for (const line of wire.slice(0, -2).split("\n")) {
          expect(
            line === "" ||
              line.startsWith("data: ") ||
              line.startsWith("event: "),
          ).toBe(true);
          if (line.startsWith("event: ")) {
            expect(line).toMatch(/^event: [A-Za-z0-9_.-]+$/);
          }
        }

        const dataLines = wire
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice("data: ".length));
        expect(JSON.parse(dataLines.join("\n"))).toEqual({ text });
      }),
      { numRuns: 200 },
    );
  });
});
