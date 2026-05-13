/**
 * P3 — slot single-flight lock + L5 first-token-latency tests for
 * `DflashLlamaServer.generateWithUsage`.
 *
 * P3: two concurrent generate calls against the same pinned `slotId`
 * MUST serialize on the JS side — the second call only contacts the
 * server after the first has fully drained. Slot `-1` ("any free slot")
 * is explicitly unlocked because it routes to whichever slot is free.
 *
 * L5: a streaming request reports `firstTokenMs` measured from the
 * outbound fetch to the first SSE chunk arriving.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { dflashLlamaServer } from "./dflash-server";

interface ServerRecord {
  startedAt: number;
  finishedAt: number;
  slotId: number | undefined;
}

async function startSerializationMockServer(opts: {
  /** ms to hold each /v1/chat/completions request before closing. */
  holdMs: number;
}): Promise<{
  baseUrl: string;
  records: ServerRecord[];
  close: () => Promise<void>;
}> {
  const records: ServerRecord[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/metrics") {
      res.statusCode = 200;
      res.end(
        [
          "llamacpp:prompt_tokens_total 0",
          "llamacpp:n_tokens_predicted_total 0",
          "llamacpp:n_drafted_total 1",
          "llamacpp:n_accepted_total 1",
        ].join("\n"),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        slot_id?: number;
      };
      const record: ServerRecord = {
        startedAt: performance.now(),
        finishedAt: 0,
        slotId: body.slot_id,
      };
      records.push(record);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, opts.holdMs));
      res.end("data: [DONE]\n\n");
      record.finishedAt = performance.now();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    records,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface TargetInternals {
  baseUrl: string | null;
  cacheParallel: number;
}

function patchTarget(baseUrl: string): { restore: () => void } {
  const target = dflashLlamaServer as unknown as TargetInternals;
  const previous = {
    baseUrl: target.baseUrl,
    cacheParallel: target.cacheParallel,
  };
  target.baseUrl = baseUrl;
  target.cacheParallel = 4;
  return {
    restore: () => {
      target.baseUrl = previous.baseUrl;
      target.cacheParallel = previous.cacheParallel;
    },
  };
}

describe("DflashLlamaServer P3 per-slot single-flight lock", () => {
  it("serializes two concurrent generateWithUsage calls against the same pinned slot", async () => {
    const mock = await startSerializationMockServer({ holdMs: 60 });
    const patch = patchTarget(mock.baseUrl);
    try {
      const [a, b] = await Promise.all([
        dflashLlamaServer.generateWithUsage({
          prompt: "first",
          slotId: 3,
          onTextChunk: () => {},
        }),
        dflashLlamaServer.generateWithUsage({
          prompt: "second",
          slotId: 3,
          onTextChunk: () => {},
        }),
      ]);
      expect(a.slotId).toBe(3);
      expect(b.slotId).toBe(3);
      expect(mock.records).toHaveLength(2);
      // Serialization: the second request started AFTER the first
      // finished. Real serialization is fine if the second begins after
      // the first ends (within a small overlap tolerance).
      const [first, second] = mock.records;
      expect(second.startedAt).toBeGreaterThanOrEqual(first.finishedAt - 5);
    } finally {
      patch.restore();
      await mock.close();
    }
  });

  it("does NOT serialize when slotId is -1 (any-free-slot)", async () => {
    const mock = await startSerializationMockServer({ holdMs: 60 });
    const patch = patchTarget(mock.baseUrl);
    try {
      const start = performance.now();
      await Promise.all([
        dflashLlamaServer.generateWithUsage({
          prompt: "a",
          slotId: -1,
          onTextChunk: () => {},
        }),
        dflashLlamaServer.generateWithUsage({
          prompt: "b",
          slotId: -1,
          onTextChunk: () => {},
        }),
      ]);
      const elapsed = performance.now() - start;
      // If unlocked, both run in parallel ≈ 60 ms total; serialized would
      // be ≈ 120 ms. Allow a generous upper bound to keep the test
      // non-flaky on a loaded CI box.
      expect(elapsed).toBeLessThan(110);
      expect(mock.records).toHaveLength(2);
    } finally {
      patch.restore();
      await mock.close();
    }
  });
});

describe("DflashLlamaServer L5 first-token-latency", () => {
  it("reports firstTokenMs on the streaming generate result", async () => {
    const mock = await startSerializationMockServer({ holdMs: 30 });
    const patch = patchTarget(mock.baseUrl);
    try {
      const result = await dflashLlamaServer.generateWithUsage({
        prompt: "say hi",
        slotId: 0,
        onTextChunk: () => {},
      });
      expect(result.firstTokenMs).not.toBeNull();
      expect(result.firstTokenMs).toBeGreaterThanOrEqual(0);
      // First chunk arrives essentially immediately in this mock (before
      // the holdMs sleep); generous upper bound for CI overhead.
      expect(result.firstTokenMs ?? Number.POSITIVE_INFINITY).toBeLessThan(500);
    } finally {
      patch.restore();
      await mock.close();
    }
  });

  it("attaches firstTokenMs to the first verifier-accept event meta", async () => {
    const mock = await startSerializationMockServer({ holdMs: 10 });
    const patch = patchTarget(mock.baseUrl);
    try {
      const metas: Array<number | undefined> = [];
      await dflashLlamaServer.generateWithUsage({
        prompt: "x",
        slotId: 0,
        onVerifierEvent: (event) => {
          if (event.kind === "accept") {
            metas.push(event.meta?.firstTokenMs);
          }
        },
      });
      // First accept carries firstTokenMs, subsequent accepts do not.
      expect(metas.length).toBeGreaterThanOrEqual(1);
      expect(metas[0]).toBeTypeOf("number");
      for (let i = 1; i < metas.length; i++) {
        expect(metas[i]).toBeUndefined();
      }
    } finally {
      patch.restore();
      await mock.close();
    }
  });
});
