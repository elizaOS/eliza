import { lookup as dnsLookup } from "node:dns/promises";
import {
  type RequestOptions as HttpRequestOptions,
  type IncomingMessage,
  request as requestHttp,
} from "node:http";
import { request as requestHttps } from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  isBlockedPrivateOrLinkLocalIp,
  normalizeHostLike,
} from "../security/network-policy.js";
import {
  parseClampedFloat,
  parsePositiveInteger,
} from "../utils/number-parsing.js";
import {
  getKnowledgeService,
  type KnowledgeServiceLike,
} from "./knowledge-service-loader.js";
import type { RouteHelpers, RouteRequestContext } from "./route-helpers.js";

export type KnowledgeRouteHelpers = RouteHelpers;

export interface KnowledgeRouteContext extends RouteRequestContext {
  url: URL;
  runtime: AgentRuntime | null;
}

const FRAGMENT_COUNT_BATCH_SIZE = 500;
const KNOWLEDGE_UPLOAD_MAX_BODY_BYTES = 32 * 1_048_576; // 32 MB
const MAX_BULK_DOCUMENTS = 100;
const MAX_URL_IMPORT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_YOUTUBE_WATCH_PAGE_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_YOUTUBE_TRANSCRIPT_BYTES = 10 * 1024 * 1024; // 10 MB
const URL_FETCH_TIMEOUT_MS = 15_000;
const BLOCKED_HOST_LITERALS = new Set([
  "localhost",
  "metadata.google.internal",
]);

function toSafeNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function hasUuidId(memory: Memory): memory is Memory & { id: UUID } {
  return typeof memory.id === "string" && memory.id.length > 0;
}

function hasUuidIdAndCreatedAt(
  memory: Memory,
): memory is Memory & { id: UUID; createdAt: number } {
  return hasUuidId(memory) && typeof memory.createdAt === "number";
}

async function countKnowledgeFragmentsForDocument(
  knowledgeService: KnowledgeServiceLike,
  roomId: UUID,
  documentId: UUID,
): Promise<number> {
  let offset = 0;
  let fragmentCount = 0;

  while (true) {
    const knowledgeBatch = await knowledgeService.getMemories({
      tableName: "knowledge",
      roomId,
      count: FRAGMENT_COUNT_BATCH_SIZE,
      offset,
    });

    if (knowledgeBatch.length === 0) {
      break;
    }

    fragmentCount += knowledgeBatch.filter((memory) => {
      const metadata = memory.metadata as Record<string, unknown> | undefined;
      return metadata?.documentId === documentId;
    }).length;

    if (knowledgeBatch.length < FRAGMENT_COUNT_BATCH_SIZE) {
      break;
    }

    offset += FRAGMENT_COUNT_BATCH_SIZE;
  }

  return fragmentCount;
}

async function mapKnowledgeFragmentsByDocumentId(
  knowledgeService: KnowledgeServiceLike,
  roomId: UUID,
  documentIds: readonly UUID[],
): Promise<Map<UUID, number>> {
  const fragmentCounts = new Map<UUID, number>();
  const trackedDocumentIds = new Set(documentIds);
  for (const documentId of trackedDocumentIds) {
    fragmentCounts.set(documentId, 0);
  }

  if (trackedDocumentIds.size === 0) return fragmentCounts;

  let offset = 0;
  while (true) {
    const knowledgeBatch = await knowledgeService.getMemories({
      tableName: "knowledge",
      roomId,
      count: FRAGMENT_COUNT_BATCH_SIZE,
      offset,
    });

    if (knowledgeBatch.length === 0) {
      break;
    }

    for (const memory of knowledgeBatch) {
      const metadata = memory.metadata as Record<string, unknown> | undefined;
      const documentId = metadata?.documentId;
      if (
        typeof documentId === "string" &&
        trackedDocumentIds.has(documentId as UUID)
      ) {
        const currentCount = fragmentCounts.get(documentId as UUID) ?? 0;
        fragmentCounts.set(documentId as UUID, currentCount + 1);
      }
    }

    if (knowledgeBatch.length < FRAGMENT_COUNT_BATCH_SIZE) {
      break;
    }
    offset += FRAGMENT_COUNT_BATCH_SIZE;
  }

  return fragmentCounts;
}

async function listKnowledgeFragmentsForDocument(
  knowledgeService: KnowledgeServiceLike,
  roomId: UUID,
  documentId: UUID,
): Promise<UUID[]> {
  let offset = 0;
  const fragmentIds: UUID[] = [];

  while (true) {
    const knowledgeBatch = await knowledgeService.getMemories({
      tableName: "knowledge",
      roomId,
      count: FRAGMENT_COUNT_BATCH_SIZE,
      offset,
    });

    for (const memory of knowledgeBatch) {
      const metadata = memory.metadata as Record<string, unknown> | undefined;
      if (metadata?.documentId === documentId && hasUuidId(memory)) {
        fragmentIds.push(memory.id);
      }
    }

    if (knowledgeBatch.length < FRAGMENT_COUNT_BATCH_SIZE) {
      break;
    }

    offset += FRAGMENT_COUNT_BATCH_SIZE;
  }

  return fragmentIds;
}

function isBlockedIp(ip: string): boolean {
  return isBlockedPrivateOrLinkLocalIp(ip);
}

type ResolvedUrlTarget = {
  parsed: URL;
  hostname: string;
  pinnedAddress: string;
};

type PinnedFetchInput = {
  url: URL;
  init: RequestInit;
  target: ResolvedUrlTarget;
  timeoutMs: number;
};

type PinnedFetchImpl = (input: PinnedFetchInput) => Promise<Response>;

function toRequestHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  headers.forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

function responseFromIncomingMessage(response: IncomingMessage): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  const status = response.statusCode ?? 500;
  const body =
    status === 204 || status === 205 || status === 304
      ? null
      : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>);

  return new Response(body, {
    status,
    statusText: response.statusMessage,
    headers,
  });
}

async function requestWithPinnedAddress(
  input: PinnedFetchInput,
): Promise<Response> {
  const { url, init, target, timeoutMs } = input;

  if (init.body !== undefined && init.body !== null) {
    throw new Error("URL fetch request body is not supported");
  }

  const method = (init.method ?? "GET").toUpperCase();
  const headers = toRequestHeaders(new Headers(init.headers));
  const requestFn = url.protocol === "https:" ? requestHttps : requestHttp;
  const family = net.isIP(target.pinnedAddress) === 6 ? 6 : 4;

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const signal = init.signal;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const onAbort = () => {
      request.destroy(new DOMException("Aborted", "AbortError"));
    };

    const requestOptions: HttpRequestOptions = {
      protocol: url.protocol,
      hostname: target.hostname,
      port: url.port ? Number(url.port) : undefined,
      method,
      path: `${url.pathname}${url.search}`,
      headers,
      lookup: (_hostname, _options, callback) => {
        callback(null, target.pinnedAddress, family);
      },
      ...(url.protocol === "https:"
        ? { servername: target.hostname }
        : undefined),
    };

    const request = requestFn(requestOptions, (response) => {
      settle(() => resolve(responseFromIncomingMessage(response)));
    });

    request.on("error", (error) => {
      settle(() => reject(error));
    });

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    timeoutHandle = setTimeout(() => {
      request.destroy(new Error(`URL fetch timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    request.end();
  });
}

let pinnedFetchImpl: PinnedFetchImpl = requestWithPinnedAddress;

// Test hook for deterministic network simulation without sockets.
export function __setPinnedFetchImplForTests(
  impl: PinnedFetchImpl | null,
): void {
  pinnedFetchImpl = impl ?? requestWithPinnedAddress;
}

async function resolveSafeUrlTarget(url: string): Promise<{
  rejection: string | null;
  target: ResolvedUrlTarget | null;
}> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { rejection: "Invalid URL format", target: null };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      rejection: "Only http:// and https:// URLs are allowed",
      target: null,
    };
  }

  const hostname = normalizeHostLike(parsed.hostname);
  if (!hostname) return { rejection: "URL hostname is required", target: null };

  if (BLOCKED_HOST_LITERALS.has(hostname)) {
    return {
      rejection: `URL host "${hostname}" is blocked for security reasons`,
      target: null,
    };
  }

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      return {
        rejection: `URL host "${hostname}" is blocked for security reasons`,
        target: null,
      };
    }
    return {
      rejection: null,
      target: {
        parsed,
        hostname,
        pinnedAddress: hostname,
      },
    };
  }

  let addresses: Array<{ address: string }>;
  try {
    const resolved = await dnsLookup(hostname, { all: true });
    addresses = Array.isArray(resolved) ? resolved : [resolved];
  } catch {
    return {
      rejection: `Could not resolve URL host "${hostname}"`,
      target: null,
    };
  }

  if (addresses.length === 0) {
    return {
      rejection: `Could not resolve URL host "${hostname}"`,
      target: null,
    };
  }
  for (const entry of addresses) {
    if (isBlockedIp(entry.address)) {
      return {
        rejection: `URL host "${hostname}" resolves to blocked address ${entry.address}`,
        target: null,
      };
    }
  }

  return {
    rejection: null,
    target: {
      parsed,
      hostname,
      pinnedAddress: addresses[0]?.address ?? "",
    },
  };
}

async function fetchWithSafety(
  url: string,
  init: RequestInit,
  timeoutMs = URL_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const { rejection, target } = await resolveSafeUrlTarget(url);
  if (rejection || !target || !target.pinnedAddress) {
    throw new Error(rejection ?? "URL validation failed");
  }

  try {
    return await pinnedFetchImpl({
      url: target.parsed,
      init,
      target,
      timeoutMs,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`URL fetch timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

function isYouTubeUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)/.test(url);
}

function extractYouTubeVideoId(url: string): string | null {
  // Handle youtu.be/VIDEO_ID
  const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];

  // Handle youtube.com/watch?v=VIDEO_ID
  const watchMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (watchMatch) return watchMatch[1];

  // Handle youtube.com/embed/VIDEO_ID
  const embedMatch = url.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
  if (embedMatch) return embedMatch[1];

  // Handle youtube.com/v/VIDEO_ID
  const vMatch = url.match(/\/v\/([a-zA-Z0-9_-]{11})/);
  if (vMatch) return vMatch[1];

  return null;
}

async function fetchYouTubeTranscript(videoId: string): Promise<string | null> {
  // Fetch the video page to get transcript data
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const response = await fetchWithSafety(watchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    return null;
  }

  const html = new TextDecoder().decode(
    await readResponseBodyWithLimit(response, MAX_YOUTUBE_WATCH_PAGE_BYTES),
  );

  // Extract the captions track URL from the page
  const captionsMatch = html.match(
    /"captions":\s*\{[^}]*"playerCaptionsTracklistRenderer":\s*\{[^}]*"captionTracks":\s*\[([^\]]+)\]/,
  );
  if (!captionsMatch) {
    // Try alternative pattern for newer YouTube format
    const altMatch = html.match(/"captionTracks":\s*\[([^\]]+)\]/);
    if (!altMatch) {
      return null;
    }
  }

  // Find the base URL for English captions (or first available)
  const baseUrlMatch = html.match(
    /"baseUrl":\s*"(https:\/\/www\.youtube\.com\/api\/timedtext[^"]+)"/,
  );
  if (!baseUrlMatch) {
    return null;
  }

  // Decode the URL (it's JSON-escaped)
  const captionUrl = baseUrlMatch[1]
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/");

  // Fetch the transcript
  const transcriptResponse = await fetchWithSafety(captionUrl, {});
  if (!transcriptResponse.ok) {
    return null;
  }

  const transcriptXml = new TextDecoder().decode(
    await readResponseBodyWithLimit(
      transcriptResponse,
      MAX_YOUTUBE_TRANSCRIPT_BYTES,
    ),
  );

  // Parse the XML transcript
  const textMatches = transcriptXml.matchAll(/<text[^>]*>([^<]*)<\/text>/g);
  const segments: string[] = [];

  for (const match of textMatches) {
    // Decode HTML entities
    const text = match[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .trim();

    if (text) {
      segments.push(text);
    }
  }

  if (segments.length === 0) {
    return null;
  }

  return segments.join(" ");
}

function readContentLengthHeader(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

async function readResponseBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = readContentLengthHeader(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new Error(`URL content exceeds maximum size of ${maxBytes} bytes`);
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`URL content exceeds maximum size of ${maxBytes} bytes`);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(
          `URL content exceeds maximum size of ${maxBytes} bytes`,
        );
      }

      chunks.push(value);
    }
  } catch (err) {
    try {
      await reader.cancel(err);
    } catch {
      // Best effort cleanup; keep the original error.
    }
    throw err;
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

async function fetchUrlContent(
  url: string,
): Promise<{ content: string; contentType: string; filename: string }> {
  // Check if it's a YouTube URL
  if (isYouTubeUrl(url)) {
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) {
      throw new Error("Invalid YouTube URL: could not extract video ID");
    }

    const transcript = await fetchYouTubeTranscript(videoId);
    if (!transcript) {
      throw new Error(
        "Could not fetch YouTube transcript. The video may not have captions available.",
      );
    }

    return {
      content: transcript,
      contentType: "text/plain",
      filename: `youtube-${videoId}-transcript.txt`,
    };
  }

  // Regular URL fetch
  const response = await fetchWithSafety(url, {
    redirect: "manual",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Eliza/1.0; +https://elizaos.ai)",
    },
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error("URL redirects are not allowed");
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch URL: ${response.status} ${response.statusText}`,
    );
  }

  const contentType =
    response.headers.get("content-type") || "application/octet-stream";
  const urlObj = new URL(url);
  const pathSegments = urlObj.pathname.split("/");
  const encodedFilename = pathSegments[pathSegments.length - 1] || "document";
  const filename = decodeURIComponent(encodedFilename);

  const buffer = await readResponseBodyWithLimit(
    response,
    MAX_URL_IMPORT_BYTES,
  );

  // For binary content, return as base64
  const isBinary =
    contentType.startsWith("application/pdf") ||
    contentType.startsWith("application/msword") ||
    contentType.startsWith("application/vnd.openxmlformats-officedocument") ||
    contentType.startsWith("image/");

  if (isBinary) {
    const base64 = Buffer.from(buffer).toString("base64");
    return { content: base64, contentType, filename };
  }

  // For text content, return as string
  const text = new TextDecoder().decode(buffer);
  return { content: text, contentType, filename };
}

export async function handleKnowledgeRoutes(
  ctx: KnowledgeRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    url,
    runtime,
    json,
    error,
    readJsonBody,
  } = ctx;

  if (!pathname.startsWith("/api/knowledge")) return false;

  const { service: knowledgeService, reason } =
    await getKnowledgeService(runtime);
  if (!knowledgeService) {
    if (reason === "timeout") {
      res.setHeader("Retry-After", "5");
      error(
        res,
        "Knowledge service is still loading. Please retry shortly.",
        503,
      );
    } else {
      error(
        res,
        "Knowledge service is not available. Agent may not be running.",
        503,
      );
    }
    return true;
  }

  if (!runtime?.agentId) {
    error(res, "Agent runtime is not available", 503);
    return true;
  }
  const agentId = runtime.agentId as UUID;

  // ── GET /api/knowledge ──────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/knowledge") {
    const documentCount = await knowledgeService.countMemories({
      tableName: "documents",
      roomId: agentId,
      unique: false,
    });

    const fragmentCount = await knowledgeService.countMemories({
      tableName: "knowledge",
      roomId: agentId,
      unique: false,
    });

    json(res, {
      ok: true,
      available: true,
      agentId,
      documentCount,
      fragmentCount,
    });
    return true;
  }

  // ── GET /api/knowledge/stats ────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/knowledge/stats") {
    const documentCount = await knowledgeService.countMemories({
      tableName: "documents",
      roomId: agentId,
      unique: false,
    });

    const fragmentCount = await knowledgeService.countMemories({
      tableName: "knowledge",
      roomId: agentId,
      unique: false,
    });

    json(res, {
      documentCount,
      fragmentCount,
      agentId,
    });
    return true;
  }

  // ── GET /api/knowledge/documents ────────────────────────────────────────
  if (method === "GET" && pathname === "/api/knowledge/documents") {
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 100);
    const offset = parsePositiveInteger(url.searchParams.get("offset"), 0);

    const documents = await knowledgeService.getMemories({
      tableName: "documents",
      roomId: agentId,
      count: limit,
      offset: offset > 0 ? offset : undefined,
    });

    const documentIds = documents.filter(hasUuidId).map((doc) => doc.id);
    const fragmentCounts = await mapKnowledgeFragmentsByDocumentId(
      knowledgeService,
      agentId,
      documentIds,
    );

    // Clean up documents for response (remove embeddings, format metadata)
    const cleanedDocuments = documents.map((doc) => {
      const metadata = doc.metadata as Record<string, unknown> | undefined;
      const documentId = hasUuidId(doc) ? doc.id : null;
      return {
        id: doc.id,
        filename: metadata?.filename || metadata?.title || "Untitled",
        contentType: metadata?.fileType || metadata?.contentType || "unknown",
        fileSize: toSafeNumber(metadata?.fileSize, 0),
        createdAt: toSafeNumber(doc.createdAt, 0),
        fragmentCount:
          documentId !== null && fragmentCounts.has(documentId)
            ? (fragmentCounts.get(documentId) ?? 0)
            : 0,
        source: metadata?.source || "upload",
        url: metadata?.url,
      };
    });

    json(res, {
      documents: cleanedDocuments,
      total: cleanedDocuments.length,
      limit,
      offset: offset > 0 ? offset : 0,
    });
    return true;
  }

  // ── GET /api/knowledge/documents/:id ────────────────────────────────────
  const docIdMatch = /^\/api\/knowledge\/documents\/([^/]+)$/.exec(pathname);
  if (method === "GET" && docIdMatch) {
    const documentId = decodeURIComponent(docIdMatch[1]) as UUID;

    const documents = await knowledgeService.getMemories({
      tableName: "documents",
      roomId: agentId,
      count: 10000,
    });

    const document = documents.find((d) => d.id === documentId);
    if (!document) {
      error(res, "Document not found", 404);
      return true;
    }

    // Get fragment count for this document
    const fragmentCount = await countKnowledgeFragmentsForDocument(
      knowledgeService,
      agentId,
      documentId,
    );

    const metadata = document.metadata as Record<string, unknown> | undefined;

    json(res, {
      document: {
        id: document.id,
        filename: metadata?.filename || metadata?.title || "Untitled",
        contentType: metadata?.fileType || metadata?.contentType || "unknown",
        fileSize: toSafeNumber(metadata?.fileSize, 0),
        createdAt: toSafeNumber(document.createdAt, 0),
        fragmentCount,
        source: metadata?.source || "upload",
        url: metadata?.url,
        content: document.content,
      },
    });
    return true;
  }

  // ── DELETE /api/knowledge/documents/:id ─────────────────────────────────
  if (method === "DELETE" && docIdMatch) {
    const documentId = decodeURIComponent(docIdMatch[1]) as UUID;

    const fragmentIds = await listKnowledgeFragmentsForDocument(
      knowledgeService,
      agentId,
      documentId,
    );

    for (const fragmentId of fragmentIds) {
      await knowledgeService.deleteMemory(fragmentId);
    }

    // Then delete the document itself
    await knowledgeService.deleteMemory(documentId);

    json(res, {
      ok: true,
      deletedFragments: fragmentIds.length,
    });
    return true;
  }

  type KnowledgeUploadDocumentBody = {
    content: string;
    filename: string;
    contentType?: string;
    metadata?: Record<string, unknown>;
  };

  async function addKnowledgeDocument(
    service: KnowledgeServiceLike,
    document: KnowledgeUploadDocumentBody,
  ): Promise<{
    documentId: UUID;
    fragmentCount: number;
    warnings?: string[];
  }> {
    let content = document.content;
    let contentType = document.contentType || "text/plain";
    const warnings: string[] = [];

    // Image files: the content is base64-encoded binary which can't be
    // text-extracted. Convert to a text description for embedding.
    if (contentType.startsWith("image/")) {
      const includeDescriptions =
        (document.metadata as Record<string, unknown>)
          ?.includeImageDescriptions === true;
      if (includeDescriptions && runtime) {
        try {
          const { ModelType } = await import("@elizaos/core");
          const dataUri = `data:${contentType};base64,${content}`;
          const description = await runtime.useModel(
            ModelType.IMAGE_DESCRIPTION,
            {
              imageUrl: dataUri,
              prompt: `Describe this image in detail for a knowledge base. Focus on text content, data, charts, and key visual elements. Image filename: ${document.filename}`,
            },
          );
          const descText =
            typeof description === "string"
              ? description
              : (description as { description?: string }).description ||
                "Image uploaded";
          content = `[Image: ${document.filename}]\n\n${descText}`;
          contentType = "text/plain";
        } catch (modelErr) {
          warnings.push(`Image description failed: ${String(modelErr)}`);
          content = `[Image: ${document.filename}] — Image description unavailable (model error).`;
          contentType = "text/plain";
        }
      } else {
        // No vision requested — store as a reference entry
        content = `[Image: ${document.filename}] — Image uploaded without text extraction.`;
        contentType = "text/plain";
      }
    }

    // MDX files: treat as markdown
    if (document.filename?.endsWith(".mdx")) {
      contentType = "text/markdown";
    }

    const result = await service.addKnowledge({
      agentId,
      worldId: agentId,
      roomId: agentId,
      entityId: agentId,
      clientDocumentId: "" as UUID, // Will be generated
      contentType,
      originalFilename: document.filename,
      content,
      metadata: document.metadata,
    });

    const warningsValue = (result as { warnings?: unknown }).warnings;
    if (Array.isArray(warningsValue)) {
      for (const w of warningsValue) {
        if (typeof w === "string") warnings.push(w);
      }
    }

    return {
      documentId: result.clientDocumentId,
      fragmentCount: result.fragmentCount,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // ── POST /api/knowledge/documents ───────────────────────────────────────
  // Upload document from base64 content or text
  if (method === "POST" && pathname === "/api/knowledge/documents") {
    const body = await readJsonBody<KnowledgeUploadDocumentBody>(req, res, {
      maxBytes: KNOWLEDGE_UPLOAD_MAX_BODY_BYTES,
    });
    if (!body) return true;

    if (!body.content || !body.filename) {
      error(res, "content and filename are required");
      return true;
    }

    let result: {
      documentId: string;
      fragmentCount: number;
      warnings?: string[];
    };
    try {
      result = await addKnowledgeDocument(knowledgeService, body);
    } catch (err) {
      error(res, `Failed to add knowledge document: ${String(err)}`, 500);
      return true;
    }

    json(res, {
      ok: true,
      documentId: result.documentId,
      fragmentCount: result.fragmentCount,
      warnings: result.warnings,
    });
    return true;
  }

  // ── POST /api/knowledge/documents/bulk ──────────────────────────────────
  if (method === "POST" && pathname === "/api/knowledge/documents/bulk") {
    const body = await readJsonBody<{
      documents?: KnowledgeUploadDocumentBody[];
    }>(req, res, {
      maxBytes: KNOWLEDGE_UPLOAD_MAX_BODY_BYTES,
    });
    if (!body) return true;

    if (!Array.isArray(body.documents) || body.documents.length === 0) {
      error(res, "documents array is required");
      return true;
    }

    if (body.documents.length > MAX_BULK_DOCUMENTS) {
      error(
        res,
        `documents array exceeds limit (${MAX_BULK_DOCUMENTS} per request)`,
      );
      return true;
    }

    const results: Array<{
      index: number;
      ok: boolean;
      filename: string;
      documentId?: UUID;
      fragmentCount?: number;
      error?: string;
      warnings?: string[];
    }> = [];

    for (const [index, document] of body.documents.entries()) {
      const filename = document?.filename || `document-${index + 1}`;
      if (
        typeof document?.content !== "string" ||
        typeof document?.filename !== "string" ||
        document.content.trim().length === 0 ||
        document.filename.trim().length === 0
      ) {
        results.push({
          index,
          ok: false,
          filename,
          error: "content and filename must be non-empty strings",
        });
        continue;
      }

      const normalizedDocument: KnowledgeUploadDocumentBody = {
        ...document,
        content: document.content,
        filename: document.filename.trim(),
      };

      try {
        const uploadResult = await addKnowledgeDocument(
          knowledgeService,
          normalizedDocument,
        );
        results.push({
          index,
          ok: true,
          filename,
          documentId: uploadResult.documentId,
          fragmentCount: uploadResult.fragmentCount,
          warnings: uploadResult.warnings,
        });
      } catch (err) {
        results.push({
          index,
          ok: false,
          filename,
          error: String(err),
        });
      }
    }

    const successCount = results.filter((item) => item.ok).length;
    const failureCount = results.length - successCount;

    json(res, {
      ok: failureCount === 0,
      total: results.length,
      successCount,
      failureCount,
      results,
    });
    return true;
  }

  // ── POST /api/knowledge/documents/url ───────────────────────────────────
  // Upload document from URL (including YouTube auto-transcription)
  if (method === "POST" && pathname === "/api/knowledge/documents/url") {
    const body = await readJsonBody<{
      url: string;
      metadata?: Record<string, unknown>;
    }>(req, res);
    if (!body) return true;

    if (!body.url?.trim()) {
      error(res, "url is required");
      return true;
    }

    const urlToFetch = body.url.trim();

    // Fetch and process the URL content
    let fetchedContent: {
      content: string;
      contentType: string;
      filename: string;
    };
    try {
      fetchedContent = await fetchUrlContent(urlToFetch);
    } catch (fetchErr) {
      error(res, `Failed to fetch URL content: ${String(fetchErr)}`, 400);
      return true;
    }

    const { content, contentType, filename } = fetchedContent;

    const result = await knowledgeService.addKnowledge({
      agentId,
      worldId: agentId,
      roomId: agentId,
      entityId: agentId,
      clientDocumentId: "" as UUID,
      contentType,
      originalFilename: filename,
      content,
      metadata: {
        ...body.metadata,
        url: urlToFetch,
        source: isYouTubeUrl(urlToFetch) ? "youtube" : "url",
      },
    });

    json(res, {
      ok: true,
      documentId: result.clientDocumentId,
      fragmentCount: result.fragmentCount,
      filename,
      contentType,
      isYouTubeTranscript: isYouTubeUrl(urlToFetch),
    });
    return true;
  }

  // ── GET /api/knowledge/search ───────────────────────────────────────────
  if (method === "GET" && pathname === "/api/knowledge/search") {
    const query = url.searchParams.get("q");
    if (!query?.trim()) {
      error(res, "Search query (q) is required");
      return true;
    }

    const threshold = parseClampedFloat(url.searchParams.get("threshold"), {
      fallback: 0.3,
      min: 0,
      max: 1,
    });
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 20);

    // Create a mock message for the search
    const searchMessage: Memory = {
      id: crypto.randomUUID() as UUID,
      entityId: agentId,
      agentId,
      roomId: agentId,
      content: { text: query.trim() },
      createdAt: Date.now(),
    };

    const results = await knowledgeService.getKnowledge(searchMessage, {
      roomId: agentId,
    });

    // Filter by threshold and limit
    const filteredResults = results
      .filter((r) => (r.similarity ?? 0) >= threshold)
      .slice(0, limit)
      .map((r) => {
        const meta = r.metadata as Record<string, unknown> | undefined;
        return {
          id: r.id,
          text: r.content?.text || "",
          similarity: r.similarity,
          documentId: meta?.documentId,
          documentTitle: meta?.filename || meta?.title || "",
          position: meta?.position,
        };
      });

    json(res, {
      query: query.trim(),
      threshold,
      results: filteredResults,
      count: filteredResults.length,
    });
    return true;
  }

  // ── GET /api/knowledge/fragments/:documentId ────────────────────────────
  const fragmentsMatch = /^\/api\/knowledge\/fragments\/([^/]+)$/.exec(
    pathname,
  );
  if (method === "GET" && fragmentsMatch) {
    const documentId = decodeURIComponent(fragmentsMatch[1]) as UUID;

    const allFragments: Array<{
      id: UUID;
      text: string;
      position: unknown;
      createdAt: number;
    }> = [];
    let fragmentOffset = 0;

    while (true) {
      const fragmentBatch = await knowledgeService.getMemories({
        tableName: "knowledge",
        roomId: agentId,
        count: FRAGMENT_COUNT_BATCH_SIZE,
        offset: fragmentOffset,
      });

      if (fragmentBatch.length === 0) {
        break;
      }

      const matchingFragments = fragmentBatch.filter((fragment) => {
        const metadata = fragment.metadata as
          | Record<string, unknown>
          | undefined;
        return metadata?.documentId === documentId;
      });

      for (const fragment of matchingFragments) {
        if (!hasUuidIdAndCreatedAt(fragment)) {
          continue;
        }
        const meta = fragment.metadata as Record<string, unknown> | undefined;
        allFragments.push({
          id: fragment.id,
          text: (fragment.content as { text?: string })?.text || "",
          position: meta?.position,
          createdAt: fragment.createdAt,
        });
      }

      if (fragmentBatch.length < FRAGMENT_COUNT_BATCH_SIZE) {
        break;
      }
      fragmentOffset += FRAGMENT_COUNT_BATCH_SIZE;
    }

    const documentFragments = allFragments
      .sort((a, b) => {
        const posA = typeof a.position === "number" ? a.position : 0;
        const posB = typeof b.position === "number" ? b.position : 0;
        return posA - posB;
      })
      .map((f) => {
        return {
          id: f.id,
          text: f.text,
          position: f.position,
          createdAt: f.createdAt,
        };
      });

    json(res, {
      documentId,
      fragments: documentFragments,
      count: documentFragments.length,
    });
    return true;
  }

  // Route not matched within /api/knowledge prefix
  return false;
}
