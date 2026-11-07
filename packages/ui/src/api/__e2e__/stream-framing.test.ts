import { describe, expect, it } from "vitest";
import { ElizaClient } from "../client-base";
import { SseEventFramer } from "../transport";

const encoder = new TextEncoder();
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
function response(source: string, chunkSize: number) {
  const bytes = encoder.encode(source);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, i + chunkSize));
      }
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
function clientFor(source: string, chunkSize: number) {
  const client = new ElizaClient("https://agent.example");
  let request: Record<string, unknown> | undefined;
  client.setRequestTransport({ request: async (_url, init) => {
    request = JSON.parse(String(init.body));
    return response(source, chunkSize);
  } });
  return {client, request: () => request};
}

describe("shared incremental SSE framing", () => {
  it.each([1, 4096])("preserves UTF-8, named events and ready/done receipts with %i-byte chunks", async (chunkSize) => {
    const receipts = [{actionName: "VIEWS", success: true, values: {viewId: "notes"}}];
    const source = ': heartbeat\r\n\r\ndata: {"text":"Hé😀"}\r\nevent: chunk\r\n\r\n' +
      event({type:"token",text:"aa"}) + event({type:"token",text:"aa"}) +
      event({type:"reply_ready",fullText:"Hé😀aaaa",actionResults:receipts}) +
      event({type:"done",fullText:"Hé😀aaaa",agentName:"Test",actionResults:receipts}) +
      event({type:"error",message:"must not run after done"});
    const {client, request} = clientFor(source, chunkSize);
    const progress: string[] = [], ready: unknown[] = [];
    const authored = "  Preserve this line.\n\n ";
    const result = await client.streamChatEndpoint("/api/chat/stream", authored,
      (_token, full) => progress.push(full ?? ""), "DM", undefined, undefined,
      {userTextFormat:"plain-v1"}, undefined, undefined, "request-id", value => ready.push(value));
    expect(progress).toEqual(["Hé😀", "Hé😀aa", "Hé😀aaaa"]);
    expect(ready).toEqual([receipts]);
    expect(result).toMatchObject({completed:true,text:"Hé😀aaaa",actionResults:receipts});
    expect(request()).toMatchObject({text:authored,streamProtocol:"delta-v2",metadata:{userTextFormat:"plain-v1"}});
  });

  it("delivers a large event exactly once and keeps following events and an unterminated legacy final frame", async () => {
    const text = "Unicode 🧪. ".repeat(20000) + "end";
    const {client} = clientFor(event({type:"token",fullText:text}) +
      'event: done\ndata: '+JSON.stringify({text,agentName:"Test"}), 17);
    const progress: string[] = [];
    const result = await client.streamChatEndpoint("/api/chat/stream", "input", (_token, full) => progress.push(full ?? ""));
    expect(progress).toEqual([text]);
    expect(result).toMatchObject({completed:true,text,agentName:"Test"});
  });

  it("returns partial text and cancels a stalled body when the owning signal aborts", async () => {
    const client = new ElizaClient("https://agent.example");
    const abort = new AbortController();
    let cancelled = false;
    client.setRequestTransport({request: async () => new Response(new ReadableStream({
      start(controller) {controller.enqueue(encoder.encode(event({type:"token",text:"Partial"})));},
      cancel() {cancelled = true;},
    }))});
    const result = await client.streamChatEndpoint("/api/chat/stream", "input", () => abort.abort(), "DM", abort.signal);
    expect(result).toMatchObject({completed:false,text:"Partial"});
    expect(cancelled).toBe(true);
  });

  it("retains all lines across fragmented large events without joining unfinished prefixes", () => {
    const text = "x".repeat(256 * 1024);
    const framer = new SseEventFramer(), events: string[][] = [];
    const source = `: heartbeat\n\nevent: token\r\ndata: ${text}\r\n\r\nevent: done\ndata: final\n\ntrailing`;
    for (let i = 0; i < source.length; i += 7) {
      framer.push(source.slice(i, i + 7), lines => {events.push([...lines]);return false;});
    }
    expect(events).toEqual([[": heartbeat"],["event: token",`data: ${text}`],["event: done","data: final"]]);
    expect(framer.takePending()).toEqual(["trailing"]);
    expect(framer.takePending()).toEqual([]);
  });
});
