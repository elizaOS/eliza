import { describe, expect, test } from "bun:test";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";

type SseEvent = {
  event: string;
  data: Record<string, unknown>;
};

async function readSse(response: Response): Promise<SseEvent[]> {
  const body = await response.text();
  return body
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice("event: ".length);
        if (line.startsWith("data: ")) dataLines.push(line.slice("data: ".length));
      }
      return {
        event,
        data: JSON.parse(dataLines.join("\n")) as Record<string, unknown>,
      };
    });
}

describe("eliza sandbox stream compatibility", () => {
  test("buffered bridge text fallback emits frontend-compatible chunk SSE", async () => {
    const service = elizaSandboxService as unknown as {
      createBridgeSseTextResponse(text: string): Response;
    };

    const events = await readSse(service.createBridgeSseTextResponse("hello stream"));

    expect(events.map((event) => event.event)).toEqual(["chunk", "done"]);
    expect(events[0].data.chunk).toBe("hello stream");
    expect(events[0].data.text).toBe("hello stream");
    expect(typeof events[0].data.messageId).toBe("string");
    expect(typeof events[0].data.timestamp).toBe("number");
    expect(events[1].data.messageId).toBe(events[0].data.messageId);
  });

  test("normalizes local app-core token frames to frontend chunk SSE", async () => {
    const service = elizaSandboxService as unknown as {
      normalizeBridgeSseResponse(response: Response): Response;
    };
    const upstream = new Response(
      [
        'data: {"type":"token","text":"he","fullText":"he"}\n\n',
        'data: {"type":"token","text":"llo","fullText":"hello"}\n\n',
        'data: {"type":"done","fullText":"hello","agentName":"Eliza"}\n\n',
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );

    const events = await readSse(service.normalizeBridgeSseResponse(upstream));

    expect(events.map((event) => event.event)).toEqual(["chunk", "chunk", "done"]);
    expect(events[0].data.chunk).toBe("he");
    expect(events[1].data.chunk).toBe("llo");
    expect(events[1].data.fullText).toBe("hello");
    expect(events[1].data.messageId).toBe(events[0].data.messageId);
    expect(events[2].data.messageId).toBe(events[0].data.messageId);
  });
});
