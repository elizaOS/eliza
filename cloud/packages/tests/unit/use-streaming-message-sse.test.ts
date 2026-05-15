import { describe, expect, test } from "bun:test";
import { processSSEMessage, type StreamChunkData } from "@/lib/hooks/use-streaming-message";

describe("use-streaming-message SSE parser", () => {
  test("accepts local app-core data-only token and done frames", () => {
    const chunks: StreamChunkData[] = [];
    let completed = false;

    processSSEMessage(
      'data: {"type":"token","text":"hi","fullText":"hi"}',
      () => {},
      (chunk) => chunks.push(chunk),
      undefined,
      undefined,
      () => {
        completed = true;
      },
    );
    processSSEMessage(
      'data: {"type":"done","fullText":"hi","agentName":"Eliza"}',
      () => {},
      (chunk) => chunks.push(chunk),
      undefined,
      undefined,
      () => {
        completed = true;
      },
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0].messageId).toBe("local-stream");
    expect(chunks[0].chunk).toBe("hi");
    expect(typeof chunks[0].timestamp).toBe("number");
    expect(completed).toBe(true);
  });
});
