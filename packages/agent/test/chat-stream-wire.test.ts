/** Exercises the host SSE writers through real loopback HTTP responses. Token reassembly, replacement and named-event framing are transport contracts; model generation and room settlement are outside this harness. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createChatTokenStreamWriter,
  DELTA_STREAM_PROTOCOL,
  initSse,
  writeChatTokenSse,
  writeSse,
  writeSseData,
  writeSseJson,
} from "../src/api/chat-stream-writer.ts";

let server: Server;
let origin: string;
const chunks = Array.from(
  { length: 40 },
  (_, index) => `${index}:界😀\n${"x".repeat(257)}`,
);
const complete = chunks.join("");
const replacement = `authoritative replacement\n${complete}`;

beforeAll(async () => {
  server = createServer((req, res) => {
    initSse(res);
    if (req.url === "/events") {
      writeSseData(res, "one\r\ntwo\rthree\nfour", "message.delta");
      writeSseData(res, "payload", "unsafe\nevent: injected");
      writeSseJson(res, { text: "line\n界😀" }, "message.stop");
    } else {
      const writer = createChatTokenStreamWriter(
        req.url === "/delta" ? DELTA_STREAM_PROTOCOL : "legacy",
        { writeChatTokenSse, writeSse },
      );
      let accumulated = "";
      for (const [index, chunk] of chunks.entries()) {
        accumulated += chunk;
        writer.writeChunk(res, chunk, accumulated, { provisional: index < 4 });
      }
      writer.writeSnapshot(res, replacement);
      writeSse(res, { type: "done", text: replacement });
    }
    res.end();
    writeSse(res, { type: "after-end" });
    writeSseData(res, "after-end");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

for (const protocol of ["legacy", "delta"] as const) {
  it(`preserves complete ${protocol} text and authoritative replacements over HTTP`, async () => {
    const response = await fetch(`${origin}/${protocol}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-transform",
    );
    const frames = (await response.text())
      .trim()
      .split("\n\n")
      .map((frame) => {
        expect(frame.startsWith("data: ")).toBe(true);
        return JSON.parse(frame.slice(6)) as {
          type: string;
          text?: string;
          fullText?: string;
          provisional?: boolean;
        };
      });
    expect(frames).toHaveLength(chunks.length + 2);
    let reconstructed = "";
    for (const [index, frame] of frames.slice(0, chunks.length).entries()) {
      expect(frame.type).toBe("token");
      expect(frame.text).toBe(chunks[index]);
      expect(frame.provisional).toBe(index < 4 ? true : undefined);
      reconstructed = frame.fullText ?? reconstructed + frame.text;
      expect(reconstructed).toBe(chunks.slice(0, index + 1).join(""));
    }
    expect(reconstructed).toBe(complete);
    const snapshots = frames
      .slice(0, chunks.length)
      .filter((frame) => frame.fullText !== undefined);
    if (protocol === "legacy") expect(snapshots).toHaveLength(chunks.length);
    else {
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots.length).toBeLessThan(chunks.length);
    }
    expect(frames[chunks.length]).toEqual({
      type: "token",
      fullText: replacement,
      ...(protocol === "legacy" ? { text: replacement } : {}),
    });
    expect(frames.at(-1)).toEqual({ type: "done", text: replacement });
  });
}

it("frames multiline data and rejects event-name injection without changing payloads", async () => {
  const response = await fetch(`${origin}/events`);
  expect(await response.text()).toBe(
    "event: message.delta\ndata: one\ndata: two\ndata: three\ndata: four\n\n" +
      "data: payload\n\n" +
      `event: message.stop\ndata: ${JSON.stringify({ text: "line\n界😀" })}\n\n`,
  );
});
