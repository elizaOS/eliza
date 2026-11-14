// Turbo's v8 artifact protocol: https://turborepo.dev/api/remote-cache-spec.
// R2 requires a known-length stream: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/.
interface Artifact {
  size: number;
  httpEtag: string;
  customMetadata?: Record<string, string>;
}

export interface CacheBucket {
  get(key: string): Promise<(Artifact & { body: ReadableStream<Uint8Array> }) | null>;
  head(key: string): Promise<Artifact | null>;
  put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, options: {
    httpMetadata: { contentType: string };
    customMetadata: Record<string, string>;
  }): Promise<Artifact | null>;
}

export interface CacheEnvironment {
  CACHE_BUCKET: CacheBucket;
  CACHE_READ_TOKEN: string;
  CACHE_WRITE_TOKEN: string;
}

declare const FixedLengthStream: {
  new(length: number): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
};

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const PREFIX = "lalalune/vibestack/";
const HASH = /^[a-fA-F0-9]{1,128}$/;
const TOKEN = /^[!-~]{32,512}$/;
const METADATA = ["x-artifact-duration", "x-artifact-tag", "x-artifact-sha", "x-artifact-dirty-hash"] as const;

class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const keyOf = (hash: string) => {
  if (!HASH.test(hash)) throw new RequestError(400, "Invalid artifact hash");
  return PREFIX + hash.toLowerCase();
};
const equal = (left: ArrayBuffer, right: ArrayBuffer) => {
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
};

async function authorize(request: Request, env: CacheEnvironment): Promise<"read" | "write"> {
  if (!TOKEN.test(env.CACHE_READ_TOKEN ?? "") || !TOKEN.test(env.CACHE_WRITE_TOKEN ?? "")
    || env.CACHE_READ_TOKEN === env.CACHE_WRITE_TOKEN) throw new RequestError(503, "Cache credentials are not configured");
  const token = request.headers.get("Authorization")?.match(/^Bearer ([!-~]{32,512})$/)?.[1];
  if (!token) throw new RequestError(401, "Unauthorized");
  const encoder = new TextEncoder();
  const digest = (value: string) => crypto.subtle.digest("SHA-256", encoder.encode(value));
  const [provided, read, write] = await Promise.all([digest(token), digest(env.CACHE_READ_TOKEN), digest(env.CACHE_WRITE_TOKEN)]);
  const mayRead = equal(provided, read), mayWrite = equal(provided, write);
  if (mayWrite) return "write";
  if (mayRead) return "read";
  throw new RequestError(401, "Unauthorized");
}

function metadataOf(headers: Headers): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const name of METADATA) {
    const value = headers.get(name);
    if (value === null) continue;
    const valid = name === "x-artifact-duration"
      ? /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value))
      : name === "x-artifact-tag"
      ? value.length <= 600 && /^[A-Za-z0-9+/=_-]*$/.test(value)
      : HASH.test(value);
    if (!valid) throw new RequestError(400, `Invalid ${name}`);
    metadata[name] = value;
  }
  return metadata;
}

function artifactHeaders(artifact: Artifact): Headers {
  const headers = new Headers({ "Content-Type": "application/octet-stream", "Content-Length": String(artifact.size),
    "Cache-Control": "private, no-store", ETag: artifact.httpEtag });
  for (const name of METADATA) {
    const value = artifact.customMetadata?.[name];
    if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

async function upload(request: Request, env: CacheEnvironment, key: string): Promise<Response> {
  const header = request.headers.get("Content-Length");
  if (header === null) throw new RequestError(411, "Content-Length is required");
  if (!/^\d{1,16}$/.test(header) || !Number.isSafeInteger(Number(header))) throw new RequestError(400, "Invalid Content-Length");
  const length = Number(header);
  if (length > MAX_ARTIFACT_BYTES) throw new RequestError(413, "Artifact is too large");
  const options = { httpMetadata: { contentType: "application/octet-stream" }, customMetadata: metadataOf(request.headers) };
  if (!request.body) {
    if (length !== 0) throw new RequestError(400, "Artifact body is missing");
    await env.CACHE_BUCKET.put(key, new Uint8Array(), options);
  } else {
    const stream = new FixedLengthStream(length), abort = new AbortController();
    const stored = env.CACHE_BUCKET.put(key, stream.readable, options);
    const copied = request.body.pipeTo(stream.writable, { signal: abort.signal });
    try {
      await Promise.all([stored, copied]);
    } catch {
      abort.abort();
      await Promise.allSettled([stored, copied]);
      throw new RequestError(503, "Artifact upload did not complete");
    }
  }
  return json({ urls: [request.url] });
}

async function readJson(request: Request): Promise<unknown> {
  if (!request.body) throw new RequestError(400, "JSON body is required");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new RequestError(413, "JSON body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RequestError(400, "Invalid JSON"); }
}

async function handle(request: Request, env: CacheEnvironment): Promise<Response> {
  const role = await authorize(request, env);
  const url = new URL(request.url), path = url.pathname.replace(/^\/v8(?=\/)/, "");
  if (path === "/artifacts/status" && request.method === "GET") return json({ status: "enabled" });
  if (path === "/artifacts/events" && request.method === "POST") {
    // Analytics are acknowledged without reading, logging, or storing their payload.
    await request.body?.cancel();
    return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
  }
  if (path === "/artifacts" && request.method === "POST") {
    const body = await readJson(request);
    const hashes = body && typeof body === "object" && "hashes" in body ? body.hashes : undefined;
    if (!Array.isArray(hashes) || hashes.length > 100 || hashes.some((hash) => typeof hash !== "string" || !HASH.test(hash)))
      throw new RequestError(400, "Expected at most 100 artifact hashes");
    const result: Record<string, unknown> = {};
    // Bounded batches keep one reader from issuing a hundred storage operations at once.
    for (let start = 0; start < hashes.length; start += 10) {
      await Promise.all(hashes.slice(start, start + 10).map(async (hash: string) => {
        const artifact = await env.CACHE_BUCKET.head(keyOf(hash));
        result[hash] = artifact ? { size: artifact.size, taskDurationMs: Number(artifact.customMetadata?.["x-artifact-duration"] ?? 0),
          ...artifact.customMetadata?.["x-artifact-tag"] !== undefined ? { tag: artifact.customMetadata["x-artifact-tag"] } : {} } : null;
      }));
    }
    return json(result);
  }
  const artifact = path.match(/^\/artifacts\/([^/]+)$/)?.[1];
  if (artifact === undefined) throw new RequestError(404, "Not found");
  const key = keyOf(artifact);
  if (request.method === "PUT") {
    if (role !== "write") throw new RequestError(403, "Forbidden");
    return upload(request, env, key);
  }
  if (request.method !== "GET" && request.method !== "HEAD") throw new RequestError(405, "Method not allowed");
  const found = request.method === "HEAD" ? await env.CACHE_BUCKET.head(key) : await env.CACHE_BUCKET.get(key);
  if (!found) throw new RequestError(404, "Artifact not found");
  return new Response("body" in found ? found.body as ReadableStream<Uint8Array> : null, { headers: artifactHeaders(found) });
}

/** One repository's authenticated artifact service; R2 and credentials are Cloudflare bindings. */
export async function fetch(request: Request, env: CacheEnvironment): Promise<Response> {
  let response: Response;
  try { response = await handle(request, env); }
  catch (error) { response = error instanceof RequestError ? json({ error: error.message }, error.status) : json({ error: "Cache storage unavailable" }, 503); }
  return request.method === "HEAD" ? new Response(null, response) : response;
}

export default { fetch };
