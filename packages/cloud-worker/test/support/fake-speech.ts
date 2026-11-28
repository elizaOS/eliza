// spec/cloud/deployment.md, "Story: Configure a deployment from one reviewed profile"
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FakeAnswer, FakeHandler, FakeRequest, FakeServer } from "./fakes.ts";
import { secrets } from "./profile.ts";

const textField = (form: FormData, name: string): string | null => {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
};

export type BatchScript =
  | { readonly kind: "answer" }
  | { readonly kind: "refuse"; readonly status: number; readonly retryAfterSeconds?: number }
  | { readonly kind: "hang" }
  | { readonly kind: "garbled" };

export type RealtimeScript =
  | { readonly kind: "accept" }
  | { readonly kind: "refuse"; readonly status: number }
  | { readonly kind: "fail" };

export type ProviderTurn = { readonly type: "turn.start" | "turn.resume" | "turn.update" | "turn.eager_end" | "turn.end"; readonly transcript?: string };

export interface Synthesized {
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface Transcribed {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly model: string;
  readonly language: string | null;
}

export interface RealtimeSeen {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingMessage["headers"];
}

export type RealtimeRoute = "stt" | "tts";

export interface SpeechFake {
  readonly synthesized: ReadonlyArray<Synthesized>;
  readonly transcribed: ReadonlyArray<Transcribed>;
  readonly connections: ReadonlyArray<RealtimeSeen>;
  readonly sttPcmBytes: number;
  readonly ttsMessages: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly drained: number;
  install(fakes: FakeServer): void;
  script(...next: ReadonlyArray<BatchScript>): void;
  scriptRealtime(...next: ReadonlyArray<RealtimeScript>): void;
  turns(next: ReadonlyArray<ProviderTurn>): void;
  closeIdle(route: RealtimeRoute, idleMs: number, code?: number): number;
}

export const spokenTranscript = "turn on the porch light";
export const transcriptDurationSeconds = 2.5;
export const synthesizedAudio = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21]);
export const pcmChunkBytes = 3_200;

const defaultTurns: ReadonlyArray<ProviderTurn> = [
  { type: "turn.start" },
  { type: "turn.update", transcript: spokenTranscript.slice(0, 7) },
  { type: "turn.end", transcript: spokenTranscript },
];

const keyed = (headers: IncomingMessage["headers"]) => headers["x-api-key"] === secrets.SPEECH_API_KEY && typeof headers["cartesia-version"] === "string";

function refusal(script: BatchScript): FakeAnswer | undefined {
  switch (script.kind) {
    case "answer":
      return undefined;
    case "refuse":
      return { status: script.status, body: { error: "scripted refusal" }, headers: script.retryAfterSeconds === undefined ? {} : { "retry-after": String(script.retryAfterSeconds) } };
    case "hang":
      return { status: 200, chunks: [], hangAfter: 0, headers: { "content-type": "audio/mpeg" } };
    case "garbled":
      return { status: 200, body: "<html>gateway</html>", headers: { "content-type": "text/html" } };
  }
}

function timedLines(text: string): string {
  const characters = [...text];
  const half = Math.ceil(characters.length / 2);
  const line = (part: ReadonlyArray<string>, offset: number) => JSON.stringify({
    audio_base64: Buffer.from(synthesizedAudio).toString("base64"),
    alignment: {
      characters: part,
      character_start_times_seconds: part.map((_, index) => (offset + index) * 0.05),
      character_end_times_seconds: part.map((_, index) => (offset + index + 1) * 0.05),
    },
  });
  return `${line(characters.slice(0, half), 0)}\n${line(characters.slice(half), half)}\n`;
}

async function formOf(request: FakeRequest): Promise<FormData> {
  return new Request("http://fake.invalid/stt", { method: "POST", headers: { "content-type": String(request.headers["content-type"]) }, body: Buffer.from(request.raw) }).formData();
}

function frame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.byteLength;
  const head = length < 126 ? Buffer.from([0x80 | opcode, length]) : length < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (length >= 126 && length < 65_536) {
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(length, 2);
  } else if (length >= 65_536) {
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([head, payload]);
}

interface Peer {
  text(value: unknown): void;
  close(code: number): void;
}

type Inbound = { readonly kind: "text"; readonly text: string } | { readonly kind: "binary"; readonly bytes: Uint8Array };

function accept(request: IncomingMessage, socket: Duplex, received: (peer: Peer, message: Inbound) => void): Peer {
  const digest = createHash("sha1").update(`${String(request.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${digest}\r\n\r\n`);
  let closing = false;
  const peer: Peer = {
    text: (value) => { if (!closing) socket.write(frame(0x1, Buffer.from(JSON.stringify(value)))); },
    close: (code) => {
      if (closing) return;
      closing = true;
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code, 0);
      socket.write(frame(0x8, body));
    },
  };
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = (pending[0] ?? 0) & 0x0f;
      const short = (pending[1] ?? 0) & 0x7f;
      const size = short === 126 ? 4 : short === 127 ? 10 : 2;
      if (pending.length < size + 4) return;
      const length = short === 126 ? pending.readUInt16BE(2) : short === 127 ? Number(pending.readBigUInt64BE(2)) : short;
      if (pending.length < size + 4 + length) return;
      const mask = pending.subarray(size, size + 4);
      const payload = Buffer.from(pending.subarray(size + 4, size + 4 + length).map((byte, index) => byte ^ (mask[index % 4] ?? 0)));
      pending = pending.subarray(size + 4 + length);
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        peer.close(code);
        socket.end();
        return;
      }
      if (opcode === 0x9) socket.write(frame(0xa, payload));
      if (opcode === 0x1) received(peer, { kind: "text", text: payload.toString("utf8") });
      if (opcode === 0x2) received(peer, { kind: "binary", bytes: payload });
    }
  });
  socket.on("error", () => socket.destroy());
  return peer;
}

export function speechFake({ sendSttConnected = true }: { readonly sendSttConnected?: boolean } = {}): SpeechFake {
  const synthesized: Synthesized[] = [];
  const transcribed: Transcribed[] = [];
  const connections: RealtimeSeen[] = [];
  const ttsMessages: Array<Readonly<Record<string, unknown>>> = [];
  const batch: BatchScript[] = [];
  const realtime: RealtimeScript[] = [];
  let script: ReadonlyArray<ProviderTurn> = defaultTurns;
  const live: Array<{ readonly route: RealtimeRoute; readonly peer: Peer; last: number; open: boolean }> = [];
  let sttPcmBytes = 0;
  let drained = 0;

  const http: FakeHandler = async (request) => {
    if (request.method !== "POST") return undefined;
    if (!keyed(request.headers)) return { status: 401, body: { error: "bad key" } };
    const scripted = refusal(batch.shift() ?? { kind: "answer" });
    if (request.path === "/tts/bytes" || request.path === "/tts/timestamps") {
      const body = JSON.parse(request.body) as Record<string, unknown>;
      synthesized.push({ path: request.path, body });
      if (scripted !== undefined) return scripted;
      if (request.path === "/tts/timestamps") return { status: 200, chunks: [timedLines(String(body.transcript))], headers: { "content-type": "application/x-ndjson" } };
      const container = (body.output_format as { readonly container?: string } | undefined)?.container;
      return { status: 200, chunks: [synthesizedAudio], headers: { "content-type": container === "wav" ? "audio/wav" : "audio/mpeg" } };
    }
    if (request.path === "/stt") {
      const form = await formOf(request);
      const file = form.get("file");
      if (!(file instanceof Blob)) return { status: 400, body: { error: "file missing" } };
      transcribed.push({ audio: new Uint8Array(await file.arrayBuffer()), mimeType: file.type, model: String(textField(form, "model")), language: textField(form, "language") });
      if (scripted !== undefined) return scripted;
      const words = spokenTranscript.split(" ").map((word, index) => ({ word, start: index * 0.4, end: index * 0.4 + 0.3 }));
      return { status: 200, body: { text: spokenTranscript, duration: transcriptDurationSeconds, words } };
    }
    return undefined;
  };

  const stt = (peer: Peer, message: Inbound) => {
    if (message.kind === "binary") {
      const first = sttPcmBytes === 0;
      sttPcmBytes += message.bytes.byteLength;
      if (first) for (const turn of script) peer.text(turn);
      return;
    }
    if ((JSON.parse(message.text) as { readonly type?: string }).type === "close") {
      drained += 1;
      peer.close(1000);
    }
  };

  const tts = (peer: Peer, message: Inbound) => {
    if (message.kind !== "text") return;
    const body = JSON.parse(message.text) as Record<string, unknown>;
    ttsMessages.push(body);
    const id = body.context_id;
    if (typeof id !== "string" || body.cancel === true) return;
    if (typeof body.transcript === "string" && body.transcript.length > 0) {
      peer.text({ type: "chunk", context_id: id, data: Buffer.alloc(pcmChunkBytes, 1).toString("base64") });
    }
    if (body.flush === true) peer.text({ type: "flush_done", context_id: id });
    if (body.continue === false) peer.text({ type: "done", context_id: id });
  };

  const upgrade = (request: IncomingMessage, socket: Duplex) => {
    const url = new URL(request.url ?? "/", "http://fake.invalid");
    const path = url.pathname.slice("/speech/realtime".length);
    connections.push({ path, query: url.searchParams, headers: request.headers });
    const scripted = realtime.length === 1 && realtime[0]?.kind === "refuse" ? realtime[0] : realtime.shift() ?? { kind: "accept" };
    const route = path === "/stt/turns/websocket" ? stt : path === "/tts/websocket" ? tts : undefined;
    if (!keyed(request.headers) || route === undefined || scripted.kind === "refuse") {
      const status = scripted.kind === "refuse" ? scripted.status : route === undefined ? 404 : 401;
      socket.end(`HTTP/1.1 ${status} Refused\r\ncontent-length: 7\r\n\r\nrefused`);
      return;
    }
    const peer = accept(request, socket, (current, message) => {
      seen.last = Date.now();
      route(current, message);
    });
    const seen = { route: route === stt ? "stt" as const : "tts" as const, peer, last: Date.now(), open: true };
    live.push(seen);
    socket.on("close", () => { seen.open = false; });
    if (scripted.kind === "fail") peer.text({ type: "error", context_id: "provider", message: "scripted failure" });
    else if (route === stt && sendSttConnected) peer.text({ type: "connected" });
  };

  return {
    synthesized,
    transcribed,
    connections,
    ttsMessages,
    get sttPcmBytes() {
      return sttPcmBytes;
    },
    get drained() {
      return drained;
    },
    install: (fakes) => {
      fakes.mount("/speech/", http);
      fakes.upgrade("/speech/realtime", upgrade);
    },
    script: (...next) => { batch.push(...next); },
    scriptRealtime: (...next) => { realtime.push(...next); },
    turns: (next) => { script = next; },
    closeIdle: (route, idleMs, code = 1000) => {
      const idle = live.filter((each) => each.open && each.route === route && Date.now() - each.last >= idleMs);
      for (const each of idle) each.peer.close(code);
      return idle.length;
    },
  };
}
