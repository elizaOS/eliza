// spec/agent/access/transport.md, "Story: Answer each local request exactly once"; spec/agent/access/transport.md, "Story: Stream a response and end it once"; spec/agent/access/transport.md, "Story: Close the listeners once"
import type { Driver, Options } from "../../gen/agent__access__transport.conformance.ts";
import type { Effect, Event, Exchange, Frame, Inbound, RouteClass, Transport } from "../../gen/agent__access__transport.ts";
import { Exchanges, inboundOf, parseFrame, type Wiring } from "../../src/access/socket.vibe";

interface Observed {
  readonly listeners: Transport["listeners"];
  readonly exchanges: readonly Exchange[];
}

const token = "driver-token";

const paths: Record<RouteClass, string> = {
  MessageRoute: "/api/conversations/c1/messages",
  SpeechRoute: "/api/asr/local-inference/transcribe",
  RunRoute: "/api/triggers/t1/execute",
  PlainRoute: "/api/echo",
};

function rawFrame(conn: number, inbound: Inbound): Uint8Array {
  const id = `conn-${conn}`;
  const headers = { authorization: `Bearer ${token}` };
  switch (inbound.tag) {
    case "Unreadable":
      return new TextEncoder().encode(JSON.stringify({ id, method: "http_get", payload: {} }));
    case "EventsSubscribe":
      return new TextEncoder().encode(JSON.stringify({ id, method: "events_subscribe", payload: { streams: ["conversation"], headers } }));
    case "HttpRequest":
    case "HttpRequestStream":
      return new TextEncoder().encode(JSON.stringify({
        id,
        method: inbound.tag === "HttpRequest" ? "http_request" : "http_request_stream",
        payload: { path: paths[inbound.route], method: "POST", headers, body: "x".repeat(inbound.bodyBytes) },
      }));
  }
}

function modelFrame(line: string): Frame {
  const frame = JSON.parse(line) as Record<string, unknown>;
  if (frame.type === "subscribed") return { tag: "Subscribed" };
  if (frame.type === "event") return { tag: "AgentEvent" };
  if (frame.ok === false) return { tag: "Refusal" };
  if (frame.ok === true) return { tag: "Result", status: Number((frame.result as { status: number }).status) };
  if (frame.stream === "response") return { tag: "Head", code: Number(frame.status) };
  if (frame.stream === "chunk") return { tag: "Chunk" };
  if (frame.stream === "complete") return frame.error === undefined ? { tag: "Complete" } : { tag: "CompleteFailed" };
  throw new TypeError(`The transport wrote an unknown frame: ${line}`);
}

let exchanges = new Exchanges();
let output: Effect[] = [];

function wiring(conn: number): Wiring {
  return {
    write: (line) => { output.push({ tag: "Write", conn, frame: modelFrame(line) }); },
    abort: () => { output.push({ tag: "Abort", conn }); },
    finish: () => undefined,
    cut: () => undefined,
  };
}

function receive(conn: number, inbound: Inbound): boolean {
  const parsed = parseFrame(rawFrame(conn, inbound));
  const dispatch = (deadlineMs: number) => { output.push({ tag: "Dispatch", conn, deadlineMs }); };
  switch (parsed.kind) {
    case "unreadable": return exchanges.receive(conn, parsed.id, { tag: "Unreadable" }, { refusal: "unreadable" });
    case "request": return exchanges.receive(conn, parsed.id, inboundOf(parsed.call), { dispatch });
    case "subscribe": return exchanges.receive(conn, parsed.id, { tag: "EventsSubscribe" }, exchanges.opensFeed(conn) ? {} : { refusal: "busy" });
  }
}

function send(event: Event): boolean {
  switch (event.type) {
    case "listen": return exchanges.listen(event.address);
    case "accept": return exchanges.accept(event.conn, wiring(event.conn));
    case "receive": return receive(event.conn, event.inbound);
    case "respond": return exchanges.respond(event.conn, { status: event.status, statusText: "", headers: {}, body: "" });
    case "handlerFails": return exchanges.fail(event.conn);
    case "expire": return exchanges.expire(event.conn);
    case "peerClose": return exchanges.peerClose(event.conn);
    case "sendHead": return exchanges.head(event.conn, { status: event.status, statusText: "", headers: {} });
    case "sendChunk": return exchanges.chunk(event.conn, new TextEncoder().encode("piece"));
    case "complete": return exchanges.complete(event.conn);
    case "publish": return exchanges.publish(event.conn, { stream: "conversation", runId: "run-1", seq: 1, payload: {} });
    case "close": return exchanges.close();
    case "releaseNext": return exchanges.releaseNext(event.ok);
    case "drop": return exchanges.drop(event.conn);
  }
}

export const driver: Driver<Observed> = {
  reset: () => {
    exchanges = new Exchanges();
    output = [];
  },
  dispatch: (_key, event) => {
    output = [];
    return send(event) ? "accepted" : "refused";
  },
  observe: () => ({ listeners: exchanges.state.listeners, exchanges: exchanges.state.exchanges }),
  observeOutput: () => output,
};

export const options: Options<Observed> = {
  view: (state) => ({ listeners: state.listeners, exchanges: state.exchanges.filter((exchange) => exchange.stage.tag !== "Ended") }),
  keys: ["listener"],
};
