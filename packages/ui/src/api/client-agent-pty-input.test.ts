// Regression: pasting >4096 chars into the web terminal was silently
// discarded. xterm delivers a paste as ONE onData chunk, the client sent it
// as ONE ws message, and the agent server drops any pty-input whose data
// exceeds its 4096-char per-message cap (DoS protection) with only a server
// log. sendPtyInput must therefore split oversized input into ordered
// <=4096-char messages that reassemble to the full paste.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { chunkPtyInput, MAX_PTY_INPUT_CHUNK_LENGTH } from "./client-agent";
import { ElizaClient } from "./client-base";

function makeClient(): {
  client: ElizaClient;
  sent: Array<Record<string, unknown>>;
} {
  setBootConfig({ branding: {} });
  const client = new ElizaClient("http://agent.example:31337", "token");
  const sent: Array<Record<string, unknown>> = [];
  vi.spyOn(client, "sendWsMessage").mockImplementation(
    (data: Record<string, unknown>) => {
      sent.push(data);
    },
  );
  return { client, sent };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendPtyInput — paste chunking", () => {
  it("sends a normal keystroke as a single message (previous behavior)", () => {
    const { client, sent } = makeClient();
    client.sendPtyInput("sess-1", "ls -la\r");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "pty-input",
      sessionId: "sess-1",
      data: "ls -la\r",
    });
  });

  it("splits a >4096-char paste into ordered <=4096 chunks covering the whole input", () => {
    const { client, sent } = makeClient();
    // A 10,000-char "stack trace" whose content encodes its own position, so
    // reassembly order is verifiable, not just length.
    const paste = Array.from({ length: 1000 }, (_, i) =>
      `line-${String(i).padStart(4, "0")}`.padEnd(10, "x"),
    ).join("");
    expect(paste.length).toBe(10_000);

    client.sendPtyInput("sess-1", paste);

    expect(sent.length).toBe(3);
    for (const msg of sent) {
      expect(msg.type).toBe("pty-input");
      expect(msg.sessionId).toBe("sess-1");
      expect(typeof msg.data).toBe("string");
      expect((msg.data as string).length).toBeLessThanOrEqual(
        MAX_PTY_INPUT_CHUNK_LENGTH,
      );
    }
    // In-order reassembly reproduces the paste exactly.
    expect(sent.map((msg) => msg.data as string).join("")).toBe(paste);
  });

  it("sends an exactly-4096-char input as one message", () => {
    const { client, sent } = makeClient();
    const paste = "a".repeat(MAX_PTY_INPUT_CHUNK_LENGTH);
    client.sendPtyInput("sess-1", paste);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.data).toBe(paste);
  });
});

describe("chunkPtyInput", () => {
  it("returns the input untouched when it fits in one chunk", () => {
    expect(chunkPtyInput("")).toEqual([""]);
    expect(chunkPtyInput("hello")).toEqual(["hello"]);
  });

  it("never splits a surrogate pair across a chunk boundary", () => {
    // "😀" is a surrogate pair; placing it to straddle the 4096 boundary
    // forces the chunker to end the first chunk one unit early.
    const paste = `${"a".repeat(MAX_PTY_INPUT_CHUNK_LENGTH - 1)}😀${"b".repeat(200)}`;
    const chunks = chunkPtyInput(paste);

    expect(chunks.join("")).toBe(paste);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_PTY_INPUT_CHUNK_LENGTH);
      // No chunk starts or ends mid-pair.
      const first = chunk.charCodeAt(0);
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    expect(chunks[0]?.length).toBe(MAX_PTY_INPUT_CHUNK_LENGTH - 1);
  });

  it("covers arbitrary sizes with ordered <=cap chunks", () => {
    for (const size of [4097, 8192, 12_289]) {
      const paste = Array.from({ length: size }, (_, i) =>
        String.fromCharCode(97 + (i % 26)),
      ).join("");
      const chunks = chunkPtyInput(paste);
      expect(chunks.every((c) => c.length <= MAX_PTY_INPUT_CHUNK_LENGTH)).toBe(
        true,
      );
      expect(chunks.join("")).toBe(paste);
    }
  });
});
