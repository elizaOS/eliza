/** Implements protocol-shaped configured-embedding, Gemini, Ollama, and z.ai loopback APIs. */

import type {
  ModelProviderFault,
  ModelProviderObservation,
  ModelProviderOperation,
  ModelProviderReadback,
  ModelProviderSeed,
} from "./types";

const JSON_HEADERS = { "content-type": "application/json" };
export const MODEL_PROVIDER_MAX_REQUEST_BYTES = 1024 * 1024;
const MODEL_PROVIDER_MAX_JSON_DEPTH = 64;
const MODEL_PROVIDER_MAX_JSON_NODES = 100_000;

class InvalidProviderRequest extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code:
      | "INVALID_JSON"
      | "REQUEST_TOO_LARGE"
      | "JSON_TOO_COMPLEX"
      | "UNSUPPORTED_ENCODING"
      | "UNSUPPORTED_MEDIA_TYPE",
  ) {
    super(code);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function boundedObservationBody(value: unknown): unknown {
  try {
    assertJsonComplexity(value);
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      MODEL_PROVIDER_MAX_REQUEST_BYTES
    ) {
      throw new InvalidProviderRequest(413, "REQUEST_TOO_LARGE");
    }
    return clone(value);
  } catch {
    return { omitted: "observation body exceeded protocol bounds" };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  return value as Record<string, unknown>;
}

function redactHeaders(headers: Headers): Record<string, string> {
  const sanitized: Record<string, string> = {};
  headers.forEach((value, key) => {
    sanitized[key] =
      key === "authorization" ||
      key === "x-goog-api-key" ||
      key === "x-api-key" ||
      key === "api-key"
        ? "<redacted>"
        : value;
  });
  return sanitized;
}

function sanitizedPath(url: URL): string {
  const copy = new URL(url);
  for (const key of ["key", "api_key", "access_token", "token"]) {
    if (copy.searchParams.has(key)) copy.searchParams.set(key, "<redacted>");
  }
  return `${copy.pathname}${copy.search}`;
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function unauthorized(provider: string): Response {
  return json(
    { error: { code: 401, message: `${provider} authentication failed` } },
    401,
  );
}

async function requestBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity")
    throw new InvalidProviderRequest(400, "UNSUPPORTED_ENCODING");
  const contentType = request.headers.get("content-type");
  if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType))
    throw new InvalidProviderRequest(400, "UNSUPPORTED_MEDIA_TYPE");
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0)
      throw new InvalidProviderRequest(400, "INVALID_JSON");
    if (length > MODEL_PROVIDER_MAX_REQUEST_BYTES)
      throw new InvalidProviderRequest(413, "REQUEST_TOO_LARGE");
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MODEL_PROVIDER_MAX_REQUEST_BYTES) {
        await reader.cancel("model-provider request body limit exceeded");
        throw new InvalidProviderRequest(413, "REQUEST_TOO_LARGE");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidProviderRequest(400, "INVALID_JSON");
  }
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new InvalidProviderRequest(400, "INVALID_JSON");
  }
  assertJsonComplexity(parsed);
  return parsed;
}

function assertJsonComplexity(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (
      nodes > MODEL_PROVIDER_MAX_JSON_NODES ||
      current.depth > MODEL_PROVIDER_MAX_JSON_DEPTH
    ) {
      throw new InvalidProviderRequest(413, "JSON_TOO_COMPLEX");
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value)
        pending.push({ value: child, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      for (const child of Object.values(current.value))
        pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function extractGoogleText(body: Record<string, unknown>): string {
  const contents = body.contents as
    | Array<{ parts?: Array<{ text?: string }> }>
    | undefined;
  const requests = body.requests as
    | Array<{ content?: { parts?: Array<{ text?: string }> } }>
    | undefined;
  return (
    contents?.[0]?.parts?.[0]?.text ??
    requests?.[0]?.content?.parts?.[0]?.text ??
    ""
  );
}

function authMatches(
  request: Request,
  expected: string | undefined,
  kind: "bearer" | "google",
) {
  if (!expected) return true;
  if (kind === "google") {
    const url = new URL(request.url);
    return (
      request.headers.get("x-goog-api-key") === expected ||
      url.searchParams.get("key") === expected
    );
  }
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

export class ModelProviderMockStore {
  private currentSeed: ModelProviderSeed;
  private faults: Partial<Record<ModelProviderOperation, ModelProviderFault[]>>;
  private observations: ModelProviderObservation[] = [];
  private staleObservations: ModelProviderObservation[] = [];
  private generationValue = 1;
  private sequence = 0;
  private ollamaModels: Set<string>;

  constructor(seed: ModelProviderSeed) {
    this.currentSeed = clone(seed);
    this.faults = clone(seed.faults ?? {});
    this.ollamaModels = new Set(seed.ollama?.models ?? []);
  }

  get seed(): Readonly<ModelProviderSeed> {
    return clone(this.currentSeed);
  }

  get generation(): number {
    return this.generationValue;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generationValue;
  }

  reset(seed: ModelProviderSeed = this.currentSeed): number {
    this.currentSeed = clone(seed);
    this.faults = clone(seed.faults ?? {});
    this.observations = [];
    this.staleObservations = [];
    this.ollamaModels = new Set(seed.ollama?.models ?? []);
    this.sequence = 0;
    this.generationValue += 1;
    return this.generationValue;
  }

  takeFault(
    operation: ModelProviderOperation,
    generation: number,
  ): ModelProviderFault | undefined {
    if (!this.isCurrent(generation)) return undefined;
    return this.faults[operation]?.shift();
  }

  hasOllamaModel(model: string): boolean {
    return this.ollamaModels.has(model);
  }

  addOllamaModel(model: string, generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.ollamaModels.add(model);
    return true;
  }

  record(
    generation: number,
    args: Omit<ModelProviderObservation, "sequence" | "generation">,
  ): void {
    const observation = {
      sequence: ++this.sequence,
      generation,
      ...clone({ ...args, body: boundedObservationBody(args.body) }),
    };
    if (this.isCurrent(generation)) this.observations.push(observation);
    else this.staleObservations.push(observation);
  }

  readback(): ModelProviderReadback {
    const remainingFaults: Partial<Record<ModelProviderOperation, number>> = {};
    for (const [operation, faults] of Object.entries(this.faults)) {
      if (faults?.length)
        remainingFaults[operation as ModelProviderOperation] = faults.length;
    }
    return {
      generation: this.generationValue,
      observations: clone(this.observations),
      staleObservations: clone(this.staleObservations),
      ollamaModels: [...this.ollamaModels].sort(),
      remainingFaults,
    };
  }
}

async function faultResponse(
  fault: ModelProviderFault | undefined,
  signal: AbortSignal,
): Promise<Response | undefined> {
  if (!fault) return undefined;
  if (fault.type === "delay") {
    await abortableDelay(fault.delayMs, signal);
    return undefined;
  }
  if (fault.type === "malformed") {
    return new Response(fault.body ?? "{not-json", {
      status: 200,
      headers: JSON_HEADERS,
    });
  }
  return json(
    fault.body ?? { error: { message: `synthetic HTTP ${fault.status}` } },
    fault.status,
    fault.headers,
  );
}

async function abortableDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted)
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", aborted, { once: true });
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
  });
}

function classify(path: string): ModelProviderOperation | null {
  if (path === "/configured/v1/embeddings") return "configured-embedding";
  if (path === "/zai/chat/completions") return "zai-chat";
  if (path.startsWith("/google/") && path.includes(":countTokens"))
    return "google-count-tokens";
  if (path.startsWith("/google/") && path.includes(":batchEmbedContents"))
    return "google-embedding";
  if (path.startsWith("/google/") && path.includes(":generateContent"))
    return "google-generate";
  if (path === "/ollama/api/version") return "ollama-version";
  if (path === "/ollama/api/show") return "ollama-model-show";
  if (path === "/ollama/api/pull") return "ollama-model-pull";
  if (path === "/ollama/api/chat") return "ollama-chat";
  if (path === "/ollama/api/embed") return "ollama-embedding";
  return null;
}

export function buildModelProviderMockFetch(store: ModelProviderMockStore) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const admittedGeneration = store.generation;
    const admittedSeed = store.seed;
    const operation = classify(url.pathname);
    if (!operation)
      return json(
        { error: { message: "unknown synthetic provider route" } },
        404,
      );
    let body: unknown;
    try {
      body = await requestBody(request);
    } catch (error) {
      if (!(error instanceof InvalidProviderRequest)) throw error;
      const response = json(
        { error: { code: error.code, message: "invalid provider request" } },
        error.status,
        { connection: "close" },
      );
      store.record(admittedGeneration, {
        operation,
        method: request.method,
        path: sanitizedPath(url),
        headers: redactHeaders(request.headers),
        body: { invalidRequest: error.code },
        status: response.status,
      });
      return response;
    }

    if (!store.isCurrent(admittedGeneration)) {
      const stale = json(
        { error: { message: "synthetic provider generation is stale" } },
        409,
      );
      store.record(admittedGeneration, {
        operation,
        method: request.method,
        path: sanitizedPath(url),
        headers: redactHeaders(request.headers),
        body,
        status: stale.status,
      });
      return stale;
    }

    let failure: Response | undefined;
    try {
      failure = await faultResponse(
        store.takeFault(operation, admittedGeneration),
        request.signal,
      );
    } catch (error) {
      store.record(admittedGeneration, {
        operation,
        method: request.method,
        path: sanitizedPath(url),
        headers: redactHeaders(request.headers),
        body,
        status: 499,
      });
      throw error;
    }
    if (!store.isCurrent(admittedGeneration)) {
      const stale = json(
        { error: { message: "synthetic provider generation is stale" } },
        409,
      );
      store.record(admittedGeneration, {
        operation,
        method: request.method,
        path: sanitizedPath(url),
        headers: redactHeaders(request.headers),
        body,
        status: stale.status,
      });
      return stale;
    }
    if (failure) {
      store.record(admittedGeneration, {
        operation,
        method: request.method,
        path: sanitizedPath(url),
        headers: redactHeaders(request.headers),
        body,
        status: failure.status,
      });
      return failure;
    }

    let response: Response;
    const row = asRecord(body);
    switch (operation) {
      case "configured-embedding": {
        if (
          !authMatches(
            request,
            admittedSeed.auth?.["configured-embedding"],
            "bearer",
          )
        ) {
          response = unauthorized("configured embedding");
          break;
        }
        const fixture = admittedSeed.configuredEmbedding;
        if (!fixture || row.model !== fixture.model) {
          response = json(
            { error: { message: "unknown embedding model" } },
            400,
          );
          break;
        }
        const inputs = Array.isArray(row.input) ? row.input : [row.input];
        if (!inputs.every((input) => typeof input === "string")) {
          response = json(
            { error: { message: "input must be string or string[]" } },
            400,
          );
          break;
        }
        const vectors = inputs.map((input) => fixture.vectors[input as string]);
        if (vectors.some((vector) => !vector)) {
          response = json(
            { error: { message: "unseeded embedding input" } },
            422,
          );
          break;
        }
        const requestedDimensions = row.dimensions;
        if (
          requestedDimensions !== undefined &&
          requestedDimensions !== fixture.dimensions
        ) {
          response = json(
            { error: { message: "unsupported dimensions" } },
            400,
          );
          break;
        }
        response = json({
          object: "list",
          data: vectors.map((embedding, index) => ({
            object: "embedding",
            index,
            embedding,
          })),
          model: fixture.model,
          usage: {
            prompt_tokens: fixture.promptTokens ?? inputs.length,
            total_tokens: fixture.promptTokens ?? inputs.length,
          },
        });
        break;
      }
      case "zai-chat": {
        if (!authMatches(request, admittedSeed.auth?.zai, "bearer")) {
          response = unauthorized("z.ai");
          break;
        }
        const fixture = admittedSeed.zai;
        if (
          !fixture ||
          row.model !== fixture.model ||
          !Array.isArray(row.messages)
        ) {
          response = json(
            { error: { message: "invalid z.ai chat request" } },
            400,
          );
          break;
        }
        response = json({
          id: "chatcmpl_synthetic",
          object: "chat.completion",
          created: 1,
          model: fixture.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: fixture.text },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: fixture.promptTokens ?? 3,
            completion_tokens: fixture.completionTokens ?? 2,
            total_tokens:
              (fixture.promptTokens ?? 3) + (fixture.completionTokens ?? 2),
          },
        });
        break;
      }
      case "google-count-tokens": {
        if (!authMatches(request, admittedSeed.auth?.google, "google")) {
          response = unauthorized("Google");
          break;
        }
        response = json({ totalTokens: admittedSeed.google?.inputTokens ?? 0 });
        break;
      }
      case "google-embedding": {
        if (!authMatches(request, admittedSeed.auth?.google, "google")) {
          response = unauthorized("Google");
          break;
        }
        response = json({
          embeddings: [{ values: admittedSeed.google?.embedding ?? [] }],
        });
        break;
      }
      case "google-generate": {
        if (!authMatches(request, admittedSeed.auth?.google, "google")) {
          response = unauthorized("Google");
          break;
        }
        const fixture = admittedSeed.google;
        response = json({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: fixture?.text ?? "" }],
              },
              finishReason: "STOP",
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: fixture?.inputTokens ?? 0,
            candidatesTokenCount: fixture?.outputTokens ?? 0,
            totalTokenCount:
              (fixture?.inputTokens ?? 0) + (fixture?.outputTokens ?? 0),
          },
        });
        break;
      }
      case "ollama-version": {
        const distribution = admittedSeed.ollama?.distribution ?? "zerollama";
        response = json({ version: "0.0.0-synthetic", distribution });
        break;
      }
      case "ollama-model-show": {
        const model = typeof row.model === "string" ? row.model : "";
        response = store.hasOllamaModel(model)
          ? json({ model_info: { "general.context_length": 8192 } })
          : json({ error: "model not found" }, 404);
        break;
      }
      case "ollama-model-pull": {
        const model = typeof row.model === "string" ? row.model : "";
        if (!model) response = json({ error: "model required" }, 400);
        else {
          response = store.addOllamaModel(model, admittedGeneration)
            ? json({ status: "success" })
            : json({ error: "synthetic provider generation is stale" }, 409);
        }
        break;
      }
      case "ollama-chat": {
        const fixture = admittedSeed.ollama;
        if (
          !fixture ||
          typeof row.model !== "string" ||
          !Array.isArray(row.messages)
        ) {
          response = json({ error: "invalid chat request" }, 400);
          break;
        }
        if (row.stream === true) {
          const chunks = fixture.streamChunks ?? [fixture.text];
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              for (const [index, chunk] of chunks.entries()) {
                controller.enqueue(
                  encoder.encode(
                    `${JSON.stringify({
                      model: row.model,
                      message: { role: "assistant", content: chunk },
                      done: index === chunks.length - 1,
                      ...(index === chunks.length - 1
                        ? {
                            done_reason: "stop",
                            prompt_eval_count: fixture.promptTokens ?? 3,
                            eval_count:
                              fixture.completionTokens ?? chunks.length,
                          }
                        : {}),
                    })}\n`,
                  ),
                );
              }
              controller.close();
            },
          });
          response = new Response(stream, {
            headers: { "content-type": "application/x-ndjson" },
          });
        } else {
          response = json({
            model: row.model,
            message: { role: "assistant", content: fixture.text },
            done: true,
            done_reason: "stop",
            prompt_eval_count: fixture.promptTokens ?? 3,
            eval_count: fixture.completionTokens ?? 2,
          });
        }
        break;
      }
      case "ollama-embedding": {
        const fixture = admittedSeed.ollama;
        const input = row.input;
        const count = Array.isArray(input) ? input.length : 1;
        response = json({
          embeddings: Array.from(
            { length: count },
            () => fixture?.embedding ?? [],
          ),
        });
        break;
      }
    }

    store.record(admittedGeneration, {
      operation,
      method: request.method,
      path: sanitizedPath(url),
      headers: redactHeaders(request.headers),
      body: operation.startsWith("google-")
        ? { ...row, extractedText: extractGoogleText(row) }
        : body,
      status: response.status,
    });
    return response;
  };
}
