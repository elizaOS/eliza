/**
 * Loopback forwarding proxy for live Cerebras evidence. It preserves request and
 * response bytes while removing credentials before any artifact reaches disk.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { dirname, join } from "node:path";

const UPSTREAM_BASE_URL = "https://api.cerebras.ai";
const REDACTED = "[REDACTED]";
const SENSITIVE_HEADER =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
const HOP_BY_HOP_HEADER =
  /^(?:connection|content-length|content-encoding|host|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade)$/i;

export type WireFault = {
  kind: "disconnect-after-first-response-chunk";
  attempts?: number;
};

export interface WireHeader {
  name: string;
  value: string;
}

export interface WireBytes {
  byteLength: number;
  sha256: string;
  base64: string;
  utf8: string;
}

export interface WireChunk extends WireBytes {
  index: number;
}

export type ParsedJsonEvidence =
  | { kind: "json"; value: unknown }
  | { kind: "not-json" }
  | { kind: "invalid-json"; error: string };

export interface CapturedWireCall {
  id: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  fault?: { kind: WireFault["kind"]; triggered: boolean };
  request?: {
    method: string;
    upstreamUrl: string;
    headers: WireHeader[];
    body: WireBytes;
    parsedBody: ParsedJsonEvidence;
  };
  response?: {
    status: number;
    statusText: string;
    headers: WireHeader[];
    headersAt: string;
    body?: WireBytes;
    chunks: WireChunk[];
    parsedBody?: ParsedJsonEvidence;
  };
  transport: {
    outcome: "pending" | "complete" | "client-aborted" | "injected-disconnect" | "proxy-error";
    error?: SerializedError;
  };
}

export interface SerializedError {
  name: string;
  message: string;
  statusCode?: number;
  code?: string;
  data?: unknown;
}

export interface CerebrasWireCapture {
  readonly baseUrl: string;
  readonly calls: CapturedWireCall[];
  armFault(fault: WireFault): void;
  close(): Promise<void>;
}

export interface CerebrasEvidenceArtifactInput {
  artifactDirectory: string;
  trajectoryPath?: string;
  calls: readonly CapturedWireCall[];
  trajectories: readonly Record<string, unknown>[];
  receipts: readonly Record<string, unknown>[];
  providerCatalog?: unknown;
  secrets: readonly string[];
  metadata: Record<string, unknown>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeBytes(bytes: Uint8Array): WireBytes {
  const buffer = Buffer.from(bytes);
  return {
    byteLength: buffer.byteLength,
    sha256: sha256(buffer),
    base64: buffer.toString("base64"),
    utf8: buffer.toString("utf8"),
  };
}

function parseJsonEvidence(bytes: Uint8Array, contentType: string | undefined): ParsedJsonEvidence {
  if (!contentType?.toLowerCase().includes("json")) {
    return { kind: "not-json" };
  }
  try {
    return { kind: "json", value: JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown };
  } catch (error) {
    // error-policy:J3 untrusted-input sanitizing — raw provider bytes remain in
    // the artifact and malformed JSON is an explicit invalid result.
    return {
      kind: "invalid-json",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function incomingHeaderEntries(headers: IncomingHttpHeaders): WireHeader[] {
  return Object.entries(headers).flatMap(([name, rawValue]) => {
    const values = Array.isArray(rawValue) ? rawValue : rawValue === undefined ? [] : [rawValue];
    return values.map((value) => ({
      name,
      value: SENSITIVE_HEADER.test(name) ? REDACTED : value,
    }));
  });
}

function responseHeaderEntries(headers: Headers): WireHeader[] {
  return [...headers.entries()].map(([name, value]) => ({
    name,
    value: SENSITIVE_HEADER.test(name) ? REDACTED : value,
  }));
}

function forwardingHeaders(headers: IncomingHttpHeaders): Headers {
  const forwarded = new Headers();
  for (const [name, rawValue] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADER.test(name) || rawValue === undefined) continue;
    forwarded.set(name, Array.isArray(rawValue) ? rawValue.join(", ") : rawValue);
  }
  // Fetch transparently decodes compressed bodies. Asking for identity keeps
  // the captured bytes identical to those delivered to the AI SDK client.
  forwarded.set("accept-encoding", "identity");
  return forwarded;
}

function applyResponseHeaders(target: import("node:http").ServerResponse, headers: Headers): void {
  for (const [name, value] of headers.entries()) {
    if (HOP_BY_HOP_HEADER.test(name) || SENSITIVE_HEADER.test(name)) continue;
    target.setHeader(name, value);
  }
}

async function readRequestBody(request: import("node:http").IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) {
    return { name: "NonError", message: String(error) };
  }
  const candidate = error as Error & {
    statusCode?: unknown;
    code?: unknown;
    data?: unknown;
  };
  return {
    name: error.name,
    message: error.message,
    ...(typeof candidate.statusCode === "number" ? { statusCode: candidate.statusCode } : {}),
    ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    ...(candidate.data !== undefined ? { data: candidate.data } : {}),
  };
}

function startServer(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("[CerebrasWireCapture] Loopback proxy did not bind a TCP port."));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function startCerebrasWireCapture(
  upstreamBaseUrl = UPSTREAM_BASE_URL
): Promise<CerebrasWireCapture> {
  const calls: CapturedWireCall[] = [];
  let faultPlan: { kind: WireFault["kind"]; remainingAttempts: number } | undefined;

  const server = createServer((request, response) => {
    const startedAtMs = Date.now();
    const call: CapturedWireCall = {
      id: randomUUID(),
      startedAt: new Date(startedAtMs).toISOString(),
      transport: { outcome: "pending" },
    };
    const fault = faultPlan;
    if (fault) {
      call.fault = { kind: fault.kind, triggered: false };
      fault.remainingAttempts--;
      if (fault.remainingAttempts === 0) faultPlan = undefined;
    }
    calls.push(call);

    const handleRequest = async () => {
      const body = await readRequestBody(request);
      const upstreamUrl = new URL(request.url ?? "/", upstreamBaseUrl).toString();
      const contentType = Array.isArray(request.headers["content-type"])
        ? request.headers["content-type"][0]
        : request.headers["content-type"];
      call.request = {
        method: request.method ?? "GET",
        upstreamUrl,
        headers: incomingHeaderEntries(request.headers),
        body: encodeBytes(body),
        parsedBody: parseJsonEvidence(body, contentType),
      };

      const abortController = new AbortController();
      let clientAborted = false;
      request.once("aborted", () => {
        clientAborted = true;
        abortController.abort(new Error("Cerebras evidence client aborted the request."));
      });
      response.once("close", () => {
        if (!response.writableEnded && call.transport.outcome !== "injected-disconnect") {
          clientAborted = true;
          abortController.abort(new Error("Cerebras evidence client closed before completion."));
        }
      });

      const upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers: forwardingHeaders(request.headers),
        body: body.byteLength > 0 ? new Uint8Array(body) : undefined,
        redirect: "manual",
        signal: abortController.signal,
      });
      const headersAt = new Date().toISOString();
      call.response = {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaderEntries(upstreamResponse.headers),
        headersAt,
        chunks: [],
      };

      response.statusCode = upstreamResponse.status;
      response.statusMessage = upstreamResponse.statusText;
      applyResponseHeaders(response, upstreamResponse.headers);

      const responseChunks: Buffer[] = [];
      if (upstreamResponse.body) {
        const reader = upstreamResponse.body.getReader();
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          const chunk = Buffer.from(part.value);
          responseChunks.push(chunk);
          call.response.chunks.push({
            index: call.response.chunks.length,
            ...encodeBytes(chunk),
          });

          if (call.fault?.kind === "disconnect-after-first-response-chunk") {
            call.fault.triggered = true;
            call.transport.outcome = "injected-disconnect";
            abortController.abort(new Error("Injected disconnect after first upstream chunk."));
            response.destroy();
            break;
          }
          response.write(chunk);
        }
      }

      const fullResponse = Buffer.concat(responseChunks);
      call.response.body = encodeBytes(fullResponse);
      call.response.parsedBody = parseJsonEvidence(
        fullResponse,
        upstreamResponse.headers.get("content-type") ?? undefined
      );
      if (!response.destroyed) response.end();
      if (call.transport.outcome === "pending") {
        call.transport.outcome = clientAborted ? "client-aborted" : "complete";
      }
    };

    handleRequest()
      .catch((error) => {
        // error-policy:J1 boundary translation — the loopback HTTP boundary
        // records the transport failure and returns an explicit 502 when the
        // client is still connected; live assertions observe the same failure.
        call.transport = {
          outcome: response.destroyed ? "client-aborted" : "proxy-error",
          error: serializeError(error),
        };
        if (!response.headersSent && !response.destroyed) {
          response.statusCode = 502;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ error: "cerebras evidence proxy upstream failure" }));
        } else if (!response.destroyed) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      })
      .finally(() => {
        const completedAtMs = Date.now();
        call.completedAt = new Date(completedAtMs).toISOString();
        call.durationMs = completedAtMs - startedAtMs;
      });
  });

  const port = await startServer(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    armFault(fault) {
      if (faultPlan) {
        throw new Error("[CerebrasWireCapture] A wire fault is already armed.");
      }
      const attempts = fault.attempts ?? 1;
      if (!Number.isSafeInteger(attempts) || attempts < 1) {
        throw new Error("[CerebrasWireCapture] Fault attempts must be a positive integer.");
      }
      faultPlan = { kind: fault.kind, remainingAttempts: attempts };
    },
    close: () => closeServer(server),
  };
}

function jsonStringifyEvidence(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, nested) => {
      if (typeof nested === "bigint") return nested.toString();
      if (typeof nested === "function") return undefined;
      return nested;
    },
    2
  );
}

function redactSecrets(serialized: string, secrets: readonly string[]): string {
  let redacted = serialized;
  for (const secret of secrets.filter((value) => value.length > 0)) {
    redacted = redacted.replaceAll(secret, REDACTED);
    redacted = redacted.replaceAll(Buffer.from(secret).toString("base64"), REDACTED);
  }
  return redacted;
}

export async function writeCerebrasEvidenceArtifacts(
  input: CerebrasEvidenceArtifactInput
): Promise<{ wirePath: string; trajectoryPath: string }> {
  await mkdir(input.artifactDirectory, { recursive: true });
  const wirePath = join(input.artifactDirectory, "cerebras-wire-evidence.json");
  const trajectoryPath =
    input.trajectoryPath ?? join(input.artifactDirectory, "cerebras-trajectory.jsonl");
  const payload = {
    schema: "eliza_cerebras_wire_evidence_v1",
    generatedAt: new Date().toISOString(),
    metadata: input.metadata,
    providerCatalog: input.providerCatalog,
    receipts: input.receipts,
    trajectories: input.trajectories,
    calls: input.calls,
  };
  const serialized = `${redactSecrets(jsonStringifyEvidence(payload), input.secrets)}\n`;
  await mkdir(dirname(wirePath), { recursive: true });
  await writeFile(wirePath, serialized, "utf8");

  const trajectoryLines = input.trajectories.map((trajectory, index) => {
    const record = {
      timestamp: new Date().toISOString(),
      callId: `cerebras-trajectory-${index + 1}`,
      ...trajectory,
    };
    return redactSecrets(JSON.stringify(record), input.secrets);
  });
  if (trajectoryLines.length > 0) {
    await mkdir(dirname(trajectoryPath), { recursive: true });
    await appendFile(trajectoryPath, `${trajectoryLines.join("\n")}\n`, "utf8");
  }
  return { wirePath, trajectoryPath };
}

export function serializeCerebrasProviderError(error: unknown): SerializedError {
  return serializeError(error);
}
