/**
 * Core vision-qa orchestration: `askAboutImage` sends ONE request per image
 * carrying ALL questions (image tokens are paid once), forces a structured
 * `{answers}` JSON response, and stamps full provenance. Flow: resolve backend →
 * cache lookup → prepare (downscale) image → build request → fetch → extract →
 * parse; on a parse rejection, spend exactly one corrective retry (counted in
 * provenance) before failing typed. `askBatch` runs the same over many images
 * with a bounded concurrency limiter implemented inline (no new dependency).
 *
 * No path here fabricates an answer or substitutes a default for a failed call.
 * A misconfigured environment throws `VISION_NOT_CONFIGURED`; a backend that
 * will not return conforming JSON throws `VISION_RESPONSE_INVALID` — the caller
 * (CLI / certify) turns those into an explicit skipped/failed record.
 */

import { EvidenceError } from "../errors.ts";
import {
  type BackendResponse,
  parseAnswers,
  RETRY_CORRECTION,
} from "./backends.ts";
import { queryHash, readCache, writeCache } from "./cache.ts";
import { CliVisionBackend } from "./cli-backend.ts";
import { createBackendClient, resolveBackend } from "./config.ts";
import { DEFAULT_MAX_EDGE, prepareImage } from "./image.ts";
import type {
  AskOptions,
  AskResult,
  BatchEntry,
  BatchResult,
  VisionAnswer,
  VisionQuestion,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;

type FetchLike = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

function assertQuestions(questions: VisionQuestion[]): void {
  if (questions.length === 0) {
    throw new EvidenceError("askAboutImage requires at least one question", {
      code: "VISION_NO_QUESTIONS",
    });
  }
  const ids = new Set<string>();
  for (const q of questions) {
    if (q.id.length === 0) {
      throw new EvidenceError("every question needs a non-empty id", {
        code: "VISION_QUESTION_INVALID",
        context: { question: q.question },
      });
    }
    if (ids.has(q.id)) {
      throw new EvidenceError(`duplicate question id: ${q.id}`, {
        code: "VISION_QUESTION_INVALID",
        context: { id: q.id },
      });
    }
    ids.add(q.id);
  }
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // error-policy:J1 transport boundary — a non-2xx from the provider is a
    // typed failure carrying status + body, not a fabricated answer.
    throw new EvidenceError(
      `vision-qa backend returned ${response.status} ${response.statusText}`,
      {
        code: "VISION_BACKEND_HTTP",
        context: { status: response.status, detail: detail.slice(0, 500) },
      },
    );
  }
  return response.json();
}

/**
 * Ask one image N questions and return validated answers with provenance.
 * Exactly one network request unless the first response fails schema parsing,
 * in which case one corrective retry is made and `retries` records it.
 */
export async function askAboutImage(
  imagePath: string,
  questions: VisionQuestion[],
  options: AskOptions = {},
): Promise<AskResult> {
  assertQuestions(questions);
  const now = options.now ?? (() => new Date());
  const fetchImpl = (options.fetchImpl ?? fetch) as unknown as FetchLike;
  const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const backend = resolveBackend(options);
  const client = createBackendClient(backend, options);
  const image = await prepareImage(imagePath, maxEdge);

  const query = queryHash(client.model, backend, questions, image.dimensions);
  const cacheRoot = options.cacheDir ?? process.cwd();
  if (options.noCache !== true) {
    const hit = readCache(cacheRoot, image.sourceSha256, query);
    if (hit !== null) {
      return { ...hit, provenance: { ...hit.provenance, cached: true } };
    }
  }

  const start = Date.now();
  let answers: VisionAnswer[] | null = null;
  // Usage accumulates across attempts: a corrective retry re-sends the image and
  // is billed again, so the recorded cost must reflect every request made.
  const usage = { inputTokens: 0, outputTokens: 0 };
  let retries = 0;
  let lastError: unknown;
  // At most two attempts: the initial ask, then one corrective retry that tells
  // the model exactly how it violated the schema. More retries would just burn
  // image tokens on a backend that cannot follow the instruction.
  for (let attempt = 0; attempt < 2 && answers === null; attempt += 1) {
    const correction = attempt === 0 ? null : RETRY_CORRECTION;
    if (attempt > 0) retries += 1;
    // The CLI backend drives a subprocess, not a request; every other backend
    // shares the fetch → extract path. Both yield the same BackendResponse, so
    // the retry loop and usage accounting below are backend-agnostic.
    let extracted: BackendResponse;
    if (client instanceof CliVisionBackend) {
      extracted = await client.invoke(image, questions, correction, {
        timeoutMs,
      });
    } else {
      const request = client.buildRequest(image, questions, correction);
      const responseBody = await postJson(
        fetchImpl,
        request.url,
        request.headers,
        request.body,
        timeoutMs,
      );
      extracted = client.extractResponse(responseBody);
    }
    usage.inputTokens += extracted.usage.inputTokens;
    usage.outputTokens += extracted.usage.outputTokens;
    try {
      answers = parseAnswers(extracted.text, questions);
    } catch (error) {
      if (
        error instanceof EvidenceError &&
        error.code === "VISION_RESPONSE_INVALID"
      ) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  if (answers === null) {
    // error-policy:J2 context-adding rethrow — the model would not produce
    // conforming JSON even after correction; surface it, never fabricate.
    throw new EvidenceError(
      "vision-qa backend did not return conforming JSON after one retry",
      {
        code: "VISION_RESPONSE_INVALID",
        cause: lastError,
        context: { backend, model: client.model, retries },
      },
    );
  }

  const result: AskResult = {
    answers,
    provenance: {
      backend,
      model: client.model,
      usage,
      latencyMs: Date.now() - start,
      retries,
      timestamp: now().toISOString(),
      cached: false,
      dimensions: image.dimensions,
    },
  };
  if (options.noCache !== true) {
    writeCache(cacheRoot, image.sourceSha256, query, result);
  }
  return result;
}

/**
 * Ask over many images with bounded concurrency. Results preserve input order.
 * The limiter is a tiny inline pool — sequential-with-N-in-flight — deliberately
 * dependency-free (the package must run in minimal containers). A per-entry
 * failure rejects the whole batch: a partial batch that silently drops failed
 * images would be exactly the "broken pipeline looks healthy" pattern this
 * codebase bans.
 */
export async function askBatch(
  entries: BatchEntry[],
  options: AskOptions & { concurrency?: number } = {},
): Promise<BatchResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const results: BatchResult[] = new Array(entries.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= entries.length) return;
      const entry = entries[index];
      results[index] = {
        imagePath: entry.imagePath,
        result: await askAboutImage(entry.imagePath, entry.questions, options),
      };
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, entries.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
