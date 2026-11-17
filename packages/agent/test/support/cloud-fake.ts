// spec/agent/host/launch.md, "Text goes to the owner's cloud account, the owner's own key, or nowhere"
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";

export type CloudReply =
  | { readonly kind: "text"; readonly chunks: readonly string[] }
  | { readonly kind: "refusal"; readonly status: number; readonly error: string; readonly retryable: boolean; readonly reason?: string; readonly retryAt?: string }
  | { readonly kind: "hang" };

export interface CloudCall {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
  readonly aborted: Promise<void>;
}

export interface CloudFake {
  readonly origin: string;
  readonly caFile: string;
  readonly calls: readonly CloudCall[];
  acceptKey(key: string): void;
  script(...replies: CloudReply[]): void;
  close(): Promise<void>;
}

export const text = (...chunks: string[]): CloudReply => ({ kind: "text", chunks });

export const refusal = (status: number, error: string, more: { retryable?: boolean; reason?: string; retryAt?: string } = {}): CloudReply =>
  ({ kind: "refusal", status, error, retryable: more.retryable ?? false, ...(more.reason === undefined ? {} : { reason: more.reason }), ...(more.retryAt === undefined ? {} : { retryAt: more.retryAt }) });

const execute = promisify(execFile);

async function selfSigned(directory: string): Promise<{ key: string; cert: string; caFile: string }> {
  const config = join(directory, "leaf.cnf");
  const keyFile = join(directory, "leaf.key");
  const caFile = join(directory, "leaf.pem");
  await writeFile(config, [
    "[req]", "prompt = no", "distinguished_name = subject", "x509_extensions = ext",
    "[subject]", "CN = localhost",
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

function modelOf(body: unknown): string {
  const model = typeof body === "object" && body !== null ? (body as { model?: unknown }).model : undefined;
  return typeof model === "string" ? model : "unknown";
}

function answerCompletion(response: ServerResponse, reply: CloudReply, body: unknown): void {
  switch (reply.kind) {
    case "hang":
      return;
    case "refusal":
      return json(response, reply.status, {
        error: reply.error,
        errorDescription: reply.error,
        retryable: reply.retryable,
        ...(reply.reason === undefined ? {} : { reason: reply.reason }),
        ...(reply.retryAt === undefined ? {} : { retryAt: reply.retryAt }),
      });
    case "text": {
      const model = modelOf(body);
      const content = reply.chunks.join("");
      const usage = { prompt_tokens: 1, completion_tokens: Math.max(1, Math.ceil(content.length / 4)), total_tokens: 1 + Math.max(1, Math.ceil(content.length / 4)) };
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
      response.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    default: {
      const unhandled: never = reply;
      throw new TypeError(`unknown reply ${JSON.stringify(unhandled)}`);
    }
  }
}

export async function startCloudFake(options: { deviceKey: string; models?: readonly string[] }): Promise<CloudFake> {
  const directory = await mkdtemp(join(tmpdir(), "agent-cloud-fake-"));
  const { key, cert, caFile } = await selfSigned(directory);
  const calls: CloudCall[] = [];
  const queue: CloudReply[] = [];
  const keys = new Set([options.deviceKey]);
  const sockets = new Set<Socket>();
  const server: Server = createServer({ key, cert }, async (request, response) => {
    const body = await readBody(request);
    const aborted = new Promise<void>((resolve) => response.once("close", () => resolve()));
    const authorization = request.headers.authorization;
    calls.push({ method: request.method ?? "", path: request.url ?? "", authorization, body, aborted });
    if (authorization === undefined || !keys.has(authorization.replace(/^Bearer /, ""))) {
      return json(response, 401, { error: "authentication_required", errorDescription: "authentication_required", retryable: false, reason: "credential_unknown" });
    }
    if (request.method === "GET" && request.url === "/api/v1/models") {
      return json(response, 200, { object: "list", data: (options.models ?? ["small", "large"]).map((id) => ({ id, object: "model" })) });
    }
    if (request.method === "POST" && request.url === "/api/v1/chat/completions") {
      return answerCompletion(response, queue.shift() ?? text("ok"), body);
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
