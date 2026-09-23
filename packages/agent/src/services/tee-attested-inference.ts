/**
 * Owns a fresh TLS connection from remote attestation through inference dispatch.
 * The measured server constructs the quote transcript from its actual socket;
 * credentials and complete request bytes wait for appraisal and durable audit.
 * This version has no connection pooling, redirects, retries or plaintext fallback.
 */
import { createHash, randomBytes } from "node:crypto";
import { connect, createServer, type Server, type TLSSocket } from "node:tls";
import { ElizaError, logger } from "@elizaos/core";
import { z } from "zod";
import {
  assertDstackReleaseCurrent,
  collectDstackAttestation,
  type DstackVerifierConfig,
  dstackVerifierConfiguration,
  verifyDstackAttestation,
} from "./tee-dstack-evidence.ts";

const ALPN = "eliza-attested-inference/1";
const DOMAIN = "eliza-attested-inference-session-v1";
const MAX_PROOF = 16 * 1024 * 1024;
const DEFAULT_PAYLOAD_LIMIT = 64 * 1024 * 1024;
const policySchema = z
  .object({ routeId: z.string().min(1), revision: z.string().min(1) })
  .strict();
export type AttestedInferencePolicy = z.infer<typeof policySchema>;
const challengeSchema = z
  .object({ nonce: z.string().regex(/^[0-9a-f]{64}$/), policy: policySchema })
  .strict();
const proofSchema = z
  .object({ attestation: z.string().regex(/^(?:[0-9a-f]{2})+$/i) })
  .strict();
const base64 = z
  .string()
  .refine((value) => Buffer.from(value, "base64").toString("base64") === value);
const headersSchema = z.array(z.tuple([z.string(), z.string()]));
const requestSchema = z
  .object({
    path: z.string().startsWith("/"),
    method: z.string(),
    headers: headersSchema,
    body: base64,
  })
  .strict();
const responseSchema = z
  .object({
    status: z.number().int().min(200).max(599),
    headers: headersSchema,
    body: base64,
  })
  .strict();

function fail(message: string, cause?: unknown): ElizaError {
  return new ElizaError(message, {
    code: "TEE_INFERENCE_TRANSPORT_REJECTED",
    ...(cause === undefined ? {} : { cause }),
  });
}
function transportEnvironment(): void {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw fail("TLS verification bypass is forbidden for attested inference");
}
function transcript(
  socket: TLSSocket,
  nonce: string,
  policy: AttestedInferencePolicy,
  peer: boolean,
): string {
  const certificate = peer
    ? socket.getPeerX509Certificate()
    : socket.getX509Certificate();
  if (!certificate) throw fail("TLS session certificate is unavailable");
  const spki = certificate.publicKey.export({
    type: "spki",
    format: "der",
  });
  const exporter = socket.exportKeyingMaterial(32, DOMAIN, Buffer.alloc(0));
  return createHash("sha256")
    .update(
      JSON.stringify([
        DOMAIN,
        nonce,
        spki.toString("base64"),
        exporter.toString("base64"),
        policy.routeId,
        policy.revision,
      ]),
    )
    .digest("hex");
}

/** One bounded frame reader owns the socket; excess protocol bytes reject whole. */
class Channel {
  private buffered = Buffer.alloc(0);
  private error: Error | undefined;
  private wake: (() => void) | undefined;
  constructor(
    private readonly socket: TLSSocket,
    private readonly signal: AbortSignal,
    private readonly maximum: number,
  ) {
    socket.on("data", (chunk: Buffer) => {
      if (this.buffered.length + chunk.length > maximum + 4) {
        this.stop(fail("Inference protocol buffer limit exceeded"));
        return;
      }
      this.buffered = Buffer.concat([this.buffered, chunk]);
      this.wake?.();
    });
    socket.on("error", (error) => this.stop(error));
    socket.on("close", () =>
      this.stop(fail("Attested inference connection closed")),
    );
    signal.addEventListener(
      "abort",
      () => this.stop(fail("Attested inference aborted", signal.reason)),
      { once: true },
    );
    if (signal.aborted)
      this.stop(fail("Attested inference aborted", signal.reason));
  }
  private stop(error: Error): void {
    this.error ??= error;
    this.socket.destroy();
    this.wake?.();
  }
  async read(limit: number): Promise<unknown> {
    for (;;) {
      this.signal.throwIfAborted();
      if (this.error) throw this.error;
      if (this.buffered.length >= 4) {
        const size = this.buffered.readUInt32BE();
        if (size > limit) throw fail("Inference protocol frame limit exceeded");
        if (this.buffered.length >= size + 4) {
          const value = this.buffered.subarray(4, size + 4);
          this.buffered = this.buffered.subarray(size + 4);
          return JSON.parse(value.toString("utf8"));
        }
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
  async write(value: object, limit: number): Promise<void> {
    this.signal.throwIfAborted();
    if (this.error) throw this.error;
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > limit || bytes.length > this.maximum)
      throw fail("Inference protocol frame limit exceeded");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length);
    await new Promise<void>((resolve, reject) =>
      this.socket.write(Buffer.concat([header, bytes]), (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
}
async function withSignal<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort: () => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(fail("Attested inference aborted", signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([work, interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function completeBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await withSignal(reader.read(), signal);
      if (next.done) return Buffer.concat(chunks);
      size += next.value.length;
      if (size > limit)
        throw fail("Complete inference payload exceeds transport limit");
      chunks.push(next.value);
    }
  } finally {
    // error-policy:J6 Cancellation is teardown; a broken producer cannot hold the socket open.
    void reader
      .cancel()
      .catch(() => logger.warn("[AttestedInference] Body cancellation failed"));
    reader.releaseLock();
  }
}
function frameLimit(payloadLimit: number): number {
  if (
    !Number.isSafeInteger(payloadLimit) ||
    payloadLimit <= 0 ||
    payloadLimit > 1024 * 1024 * 1024
  )
    throw fail("Invalid inference payload limit");
  return Math.ceil((payloadLimit * 4) / 3) + 1024 * 1024;
}
export interface AttestedInferenceClientConfig {
  origin: string;
  ca?: string;
  policy: AttestedInferencePolicy;
  verifier: DstackVerifierConfig;
  timeoutMs?: number;
  maxPayloadBytes?: number;
  /** Must await durable same-agent dispatch audit and recheck current route authority. */
  beforeDispatch(context: {
    policy: AttestedInferencePolicy;
    url: string;
    signal: AbortSignal;
    evidenceDigest: string;
    connectionBindingDigest: string;
  }): Promise<void>;
}

/** Fetch-compatible transport; no application data crosses before admission. */
export function createAttestedInferenceFetch(
  config: AttestedInferenceClientConfig,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const origin = new URL(config.origin);
  const verifier = dstackVerifierConfiguration.parse(config.verifier);
  const beforeDispatch = config.beforeDispatch;
  const ca = config.ca;
  const payloadLimit = config.maxPayloadBytes ?? DEFAULT_PAYLOAD_LIMIT;
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw fail("Attested inference requires a fixed HTTPS origin");
  const policy = Object.freeze(policySchema.parse(config.policy));
  const maximum = frameLimit(payloadLimit);
  const timeoutMs = z
    .number()
    .int()
    .positive()
    .max(300_000)
    .parse(config.timeoutMs ?? 60_000);
  return async (input, init) => {
    transportEnvironment();
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin !== origin.origin ||
      url.username ||
      url.password ||
      url.hash
    )
      throw fail("Inference request differs from its attested origin");
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    const body = await completeBody(request.body, payloadLimit, signal);
    const payload = {
      path: url.pathname + url.search,
      method: request.method,
      headers: Array.from(request.headers.entries()),
      body: body.toString("base64"),
    };
    if (Buffer.byteLength(JSON.stringify(payload)) > maximum)
      throw fail("Complete inference request exceeds transport limit");
    signal.throwIfAborted();
    const socket = connect({
      host: origin.hostname,
      port: Number(origin.port || 443),
      servername: origin.hostname,
      ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ALPNProtocols: [ALPN],
    });
    const channel = new Channel(socket, signal, Math.max(maximum, MAX_PROOF));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
        socket.once("close", () =>
          reject(fail("TLS connection closed before admission")),
        );
      });
      if (!socket.authorized || socket.alpnProtocol !== ALPN)
        throw fail("TLS peer authentication or protocol negotiation failed");
      const nonce = randomBytes(32).toString("hex");
      const reportDataHex = transcript(socket, nonce, policy, true);
      await channel.write({ nonce, policy }, MAX_PROOF);
      const proof = proofSchema.parse(await channel.read(MAX_PROOF));
      await verifyDstackAttestation(
        verifier,
        proof.attestation,
        { nonce, reportDataHex },
        signal,
      );
      await withSignal(
        beforeDispatch({
          policy,
          url: request.url,
          signal,
          evidenceDigest: createHash("sha256")
            .update(Buffer.from(proof.attestation, "hex"))
            .digest("hex"),
          connectionBindingDigest: reportDataHex,
        }),
        signal,
      );
      signal.throwIfAborted();
      assertDstackReleaseCurrent(verifier);
      await channel.write(payload, maximum);
      const reply = responseSchema.parse(await channel.read(maximum));
      if (reply.status >= 300 && reply.status < 400)
        throw fail("Inference redirects are forbidden");
      const resultBody = Buffer.from(reply.body, "base64");
      if (resultBody.length > payloadLimit)
        throw fail("Complete inference response exceeds transport limit");
      return new Response(resultBody.length ? resultBody : null, {
        status: reply.status,
        headers: reply.headers,
      });
    } catch (error) {
      // error-policy:J2 A failed or ambiguous dispatch is never retried or downgraded.
      throw fail(
        "Attested inference request failed; no automatic retry",
        error,
      );
    } finally {
      socket.destroy();
    }
  };
}

export interface AttestedInferenceServerConfig {
  /** Key and certificate must originate and remain inside the measured service. */
  key: string;
  cert: string;
  guestSocketPath: string;
  policy: AttestedInferencePolicy;
  timeoutMs?: number;
  maxPayloadBytes?: number;
  /** The measured handler must independently enforce any downstream inference hop. */
  handle(request: Request): Promise<Response>;
}
/** Serve one admitted inference request per TLS session without a generic quote API. */
export function createAttestedInferenceServer(
  config: AttestedInferenceServerConfig,
): Server {
  const policy = Object.freeze(policySchema.parse(config.policy));
  const maximum = frameLimit(config.maxPayloadBytes ?? DEFAULT_PAYLOAD_LIMIT);
  const timeoutMs = z
    .number()
    .int()
    .positive()
    .max(300_000)
    .parse(config.timeoutMs ?? 60_000);
  return createServer(
    {
      key: config.key,
      cert: config.cert,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ALPNProtocols: [ALPN],
    },
    (socket) => {
      const signal = AbortSignal.timeout(timeoutMs);
      const channel = new Channel(socket, signal, Math.max(maximum, MAX_PROOF));
      const serve = async () => {
        if (socket.alpnProtocol !== ALPN)
          throw fail("Attested inference protocol required");
        const challenge = challengeSchema.parse(await channel.read(MAX_PROOF));
        if (
          challenge.policy.routeId !== policy.routeId ||
          challenge.policy.revision !== policy.revision
        )
          throw fail("Inference route policy mismatch");
        const reportData = transcript(socket, challenge.nonce, policy, false);
        const attestation = await collectDstackAttestation(
          config.guestSocketPath,
          reportData,
          signal,
        );
        await channel.write({ attestation }, MAX_PROOF);
        const payload = requestSchema.parse(await channel.read(maximum));
        const body = Buffer.from(payload.body, "base64");
        if (body.length > (config.maxPayloadBytes ?? DEFAULT_PAYLOAD_LIMIT))
          throw fail("Complete inference request exceeds transport limit");
        const url = new URL(payload.path, "https://attested-service.invalid");
        if (url.origin !== "https://attested-service.invalid")
          throw fail("Inference request target must be relative");
        const request = new Request(url, {
          method: payload.method,
          headers: payload.headers,
          ...(body.length ? { body } : {}),
          signal,
        });
        const response = await config.handle(request);
        const responseBody = await completeBody(
          response.body,
          config.maxPayloadBytes ?? DEFAULT_PAYLOAD_LIMIT,
          signal,
        );
        await channel.write(
          {
            status: response.status,
            headers: Array.from(response.headers.entries()),
            body: responseBody.toString("base64"),
          },
          maximum,
        );
        socket.end();
      };
      void serve().catch(() => {
        // error-policy:J1 Transport boundary closes failed sessions without exposing request data.
        logger.warn("[AttestedInference] Session rejected");
        socket.destroy();
      });
    },
  );
}
