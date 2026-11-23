// spec/agent/host/launch.md, "Text goes to the owner's cloud account, the owner's own key, or nowhere"
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";

export type CloudReply =
  | { readonly kind: "text"; readonly chunks: readonly string[]; readonly cachedTokens?: number }
  | { readonly kind: "refusal"; readonly status: number; readonly error: string; readonly retryable: boolean; readonly reason?: string; readonly retryAt?: number | string; readonly resetsAt?: number; readonly retryAfterSeconds?: number }
  | { readonly kind: "images" }
  | { readonly kind: "drop" }
  | { readonly kind: "hang" }
  | { readonly kind: "partial"; readonly chunks: readonly string[] }
  | { readonly kind: "held"; readonly gate: Promise<void>; readonly reply: CloudReply }
  | { readonly kind: "tools"; readonly content: string; readonly calls: readonly { readonly name: string; readonly arguments: unknown }[] };

export interface CloudCall {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: unknown;
  readonly aborted: Promise<void>;
}

export type RouteReply =
  | { readonly kind: "json"; readonly status: number; readonly body: unknown }
  | { readonly kind: "status"; readonly status: number };

export type Dialect = "cloud" | "openai";

export interface CloudFake {
  readonly origin: string;
  readonly caFile: string;
  readonly calls: readonly CloudCall[];
  readonly ownKeyBaseUrl: string;
  readonly ownKey: string;
  acceptKey(key: string): void;
  nextCompletion(): Promise<CloudCall>;
  script(...replies: CloudReply[]): void;
  route(method: string, path: string, reply: RouteReply): void;
  close(): Promise<void>;
}

export const text = (...chunks: string[]): CloudReply => ({ kind: "text", chunks });
export const cachedText = (cachedTokens: number, ...chunks: string[]): CloudReply => ({ kind: "text", chunks, cachedTokens });

export const refusal = (status: number, error: string, more: { retryable?: boolean; reason?: string; retryAt?: number | string; resetsAt?: number; retryAfterSeconds?: number } = {}): CloudReply =>
  ({
    kind: "refusal", status, error, retryable: more.retryable ?? false,
    ...(more.reason === undefined ? {} : { reason: more.reason }),
    ...(more.retryAt === undefined ? {} : { retryAt: more.retryAt }),
    ...(more.resetsAt === undefined ? {} : { resetsAt: more.resetsAt }),
    ...(more.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: more.retryAfterSeconds }),
  });

export const insufficientCredits = (): CloudReply => refusal(402, "insufficient_credits");
export const allowanceExhausted = (resetsAt: number): CloudReply => refusal(402, "allowance_exhausted", { resetsAt });
export const rateLimited = (retryAt: number): CloudReply => refusal(429, "rate_limited", { retryable: true, retryAt });
export const unavailable = (retryAfterSeconds: number): CloudReply => refusal(503, "service_unavailable", { retryable: true, retryAfterSeconds });
export const dropped = (): CloudReply => ({ kind: "drop" });
export const partial = (...chunks: string[]): CloudReply => ({ kind: "partial", chunks });
export const echoImages = (): CloudReply => ({ kind: "images" });
export const toolCalls = (content: string, ...calls: { name: string; arguments: unknown }[]): CloudReply => ({ kind: "tools", content, calls });
export const held = (gate: Promise<void>, reply: CloudReply): CloudReply => ({ kind: "held", gate, reply });
export const answerJson = (body: unknown, status = 200): RouteReply => ({ kind: "json", status, body });
export const answerStatus = (status: number): RouteReply => ({ kind: "status", status });

const ownKeyPrefix = "/own-key/v1";

const execute = promisify(execFile);

async function selfSigned(directory: string): Promise<{ key: string; cert: string; caFile: string }> {
  const config = join(directory, "leaf.cnf");
  const keyFile = join(directory, "leaf.key");
  const caFile = join(directory, "leaf.pem");
  await writeFile(config, [
    "[req]", "prompt = no", "distinguished_name = subject", "x509_extensions = ext",
    "[subject]", `CN = cloud-fake-${randomUUID()}`,
    "[ext]", "basicConstraints = critical, CA:TRUE", "keyUsage = critical, digitalSignature, keyCertSign",
    "extendedKeyUsage = serverAuth", "subjectAltName = DNS:localhost, IP:127.0.0.1", "",
  ].join("\n"));
  await execute("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-config", config, "-keyout", keyFile, "-out", caFile]);
  return { key: await readFile(keyFile, "utf8"), cert: await readFile(caFile, "utf8"), caFile };
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.once("error", reject);
    request.once("end", () => {
      const raw = Buffer.concat(parts).toString("utf8");
      if (raw === "") return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function streams(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { stream?: unknown }).stream === true;
}

function usageAsked(body: unknown): boolean {
  const options = typeof body === "object" && body !== null ? (body as { stream_options?: { include_usage?: unknown } }).stream_options : undefined;
  return options?.include_usage === true;
}

function endStream(response: ServerResponse, body: unknown, model: string, finishReason: string, usage: object): void {
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
  if (usageAsked(body)) response.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [], usage })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function modelOf(body: unknown): string {
  const model = typeof body === "object" && body !== null ? (body as { model?: unknown }).model : undefined;
  return typeof model === "string" ? model : "unknown";
}

type ContentPart = { type?: unknown; image_url?: { url?: unknown } };
const contentOf = (message: { content?: unknown }): readonly unknown[] => Array.isArray(message.content) ? message.content : [];
const isContentPart = (part: unknown): part is ContentPart => typeof part === "object" && part !== null;

function imageUrls(body: unknown): string[] {
  const messages = typeof body === "object" && body !== null ? (body as { messages?: unknown }).messages : undefined;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap(contentOf).filter(isContentPart)
    .flatMap((part) => part.type === "image_url" && typeof part.image_url?.url === "string" ? [part.image_url.url] : []);
}

function answerCompletion(response: ServerResponse, reply: CloudReply, body: unknown, dialect: Dialect): void {
  switch (reply.kind) {
    case "hang":
      return;
    case "partial":
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      for (const chunk of reply.chunks)
        response.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", model: modelOf(body), choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
      return;
    case "held":
      void reply.gate.then(() => answerCompletion(response, reply.reply, body, dialect));
      return;
    case "drop":
      response.destroy();
      return;
    case "images":
      return answerCompletion(response, text(`images:${imageUrls(body).join(",")}`), body, dialect);
    case "refusal":
      if (reply.retryAfterSeconds !== undefined) response.setHeader("retry-after", String(reply.retryAfterSeconds));
      if (dialect === "openai") return json(response, reply.status, { error: { message: reply.error, type: reply.error, code: reply.reason ?? reply.error } });
      return json(response, reply.status, {
        error: reply.error,
        errorDescription: reply.error,
        retryable: reply.retryable,
        ...(reply.reason === undefined ? {} : { reason: reply.reason }),
        ...(reply.retryAt === undefined ? {} : { retryAt: reply.retryAt }),
        ...(reply.resetsAt === undefined ? {} : { resetsAt: reply.resetsAt }),
      });
    case "text": {
      const model = modelOf(body);
      const content = reply.chunks.join("");
      const cached = reply.cachedTokens ?? 0;
      const completion = Math.max(1, Math.ceil(content.length / 4));
      const usage = {
        prompt_tokens: 1 + cached, completion_tokens: completion, total_tokens: 1 + cached + completion,
        ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
      };
      if (!streams(body)) {
        return json(response, 200, {
          id: "chatcmpl-fake", object: "chat.completion", model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage,
        });
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      for (const chunk of reply.chunks) {
        response.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
      }
      return endStream(response, body, model, "stop", usage);
    }
    case "tools": {
      const model = modelOf(body);
      const calls = reply.calls.map(({ name, arguments: args }, index) => ({ id: `call-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }));
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (!streams(body)) {
        return json(response, 200, {
          id: "chatcmpl-fake", object: "chat.completion", model,
          choices: [{ index: 0, message: { role: "assistant", content: reply.content || null, tool_calls: calls }, finish_reason: "tool_calls" }], usage,
        });
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      if (reply.content) response.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: reply.content }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: calls.map((call, index) => ({ index, ...call })) }, finish_reason: null }] })}\n\n`);
      return endStream(response, body, model, "tool_calls", usage);
    }
    default: {
      const unhandled: never = reply;
      throw new TypeError(`unknown reply ${JSON.stringify(unhandled)}`);
    }
  }
}

function answerRoute(response: ServerResponse, reply: RouteReply): void {
  switch (reply.kind) {
    case "json":
      return json(response, reply.status, reply.body);
    case "status":
      response.writeHead(reply.status).end();
      return;
    default: {
      const unhandled: never = reply;
      throw new TypeError(`unknown route reply ${JSON.stringify(unhandled)}`);
    }
  }
}

export async function startCloudFake(options: { deviceKey: string; ownKey?: string; models?: readonly string[] }): Promise<CloudFake> {
  const directory = await mkdtemp(join(tmpdir(), "agent-cloud-fake-"));
  const { key, cert, caFile } = await selfSigned(directory);
  const calls: CloudCall[] = [];
  const completions: ((call: CloudCall) => void)[] = [];
  const queue: CloudReply[] = [];
  const keys = new Set([options.deviceKey]);
  const ownKey = options.ownKey ?? "own-key-1";
  const routes = new Map<string, RouteReply>();
  const models = () => ({ object: "list", data: (options.models ?? ["small", "large"]).map((id) => ({ id, object: "model" })) });
  const sockets = new Set<Socket>();
  const server: Server = createServer({ key, cert }, async (request, response) => {
    const body = await readBody(request);
    const aborted = new Promise<void>((resolve) => response.once("close", () => resolve()));
    const authorization = request.headers.authorization;
    const idempotencyKey = request.headers["idempotency-key"];
    const call = { method: request.method ?? "", path: request.url ?? "", authorization, idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : undefined, body, aborted };
    calls.push(call);
    const pathname = new URL(request.url ?? "/", "https://localhost").pathname;
    if (call.method === "POST" && pathname.endsWith("/chat/completions")) completions.shift()?.(call);
    if (pathname.startsWith(`${ownKeyPrefix}/`)) {
      if (authorization !== `Bearer ${ownKey}`) {
        return json(response, 401, { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } });
      }
      const call = pathname.slice(ownKeyPrefix.length);
      if (request.method === "GET" && call === "/models") return json(response, 200, models());
      if (request.method === "POST" && call === "/chat/completions") return answerCompletion(response, queue.shift() ?? text("ok"), body, "openai");
      return json(response, 404, { error: { message: "not found", type: "invalid_request_error", code: "not_found" } });
    }
    if (authorization === undefined || !keys.has(authorization.replace(/^Bearer /, ""))) {
      return json(response, 401, { error: "authentication_required", errorDescription: "authentication_required", retryable: false, reason: "credential_unknown" });
    }
    const scripted = routes.get(`${request.method ?? ""} ${pathname}`);
    if (scripted !== undefined) return answerRoute(response, scripted);
    const route = (request.url ?? "").replace(/^\/api(?=\/v1\/)/, "");
    if (request.method === "GET" && route === "/v1/models") return json(response, 200, models());
    if (request.method === "POST" && route === "/v1/chat/completions") {
      return answerCompletion(response, queue.shift() ?? text("ok"), body, "cloud");
    }
    return json(response, 404, { error: "not_found", errorDescription: "not_found", retryable: false });
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), cert]);
  return {
    origin: `https://localhost:${port}`,
    caFile,
    calls,
    nextCompletion: () => new Promise<CloudCall>((resolve) => { completions.push(resolve); }),
    ownKeyBaseUrl: `https://localhost:${port}${ownKeyPrefix}`,
    ownKey,
    route: (method, path, reply) => {
      routes.set(`${method} ${path}`, reply);
    },
    acceptKey: (next) => {
      keys.clear();
      keys.add(next);
    },
    script: (...replies) => {
      queue.push(...replies);
    },
    close: async () => {
      tls.setDefaultCACertificates(tls.getCACertificates("default").filter((trusted) => trusted.trim() !== cert.trim()));
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
