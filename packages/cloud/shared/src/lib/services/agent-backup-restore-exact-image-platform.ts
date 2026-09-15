/**
 * Resolve one database-authorized GHCR image generation to the exact child
 * manifest for a reserved Linux node platform.
 *
 * The caller's image reference is only a repository locator. A mutable tag is
 * never sent to GHCR: every manifest request is rebuilt from `imageDigest`.
 * No result is cached and every response is bounded and content-addressed.
 */

import { createHash } from "node:crypto";
import { logger } from "../utils/logger";

export const AGENT_BACKUP_RESTORE_EXACT_IMAGE_FETCH_TIMEOUT_MS = 5_000;
export const AGENT_BACKUP_RESTORE_EXACT_IMAGE_TOKEN_MAX_BYTES = 64 * 1024;
export const AGENT_BACKUP_RESTORE_EXACT_IMAGE_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
export const AGENT_BACKUP_RESTORE_EXACT_IMAGE_CONFIG_MAX_BYTES = 1024 * 1024;
export const AGENT_BACKUP_RESTORE_EXACT_IMAGE_INDEX_MAX_DESCRIPTORS = 256;

const OCI_IMAGE_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_IMAGE_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_IMAGE_CONFIG = "application/vnd.oci.image.config.v1+json";
const DOCKER_MANIFEST_LIST = "application/vnd.docker.distribution.manifest.list.v2+json";
const DOCKER_IMAGE_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const DOCKER_IMAGE_CONFIG = "application/vnd.docker.container.image.v1+json";
const OCTET_STREAM = "application/octet-stream";

const INDEX_MEDIA_TYPES = new Set([OCI_IMAGE_INDEX, DOCKER_MANIFEST_LIST]);
const MANIFEST_MEDIA_TYPES = new Set([OCI_IMAGE_MANIFEST, DOCKER_IMAGE_MANIFEST]);
const ACCEPTED_MANIFEST_MEDIA_TYPES = [
  OCI_IMAGE_INDEX,
  OCI_IMAGE_MANIFEST,
  DOCKER_MANIFEST_LIST,
  DOCKER_IMAGE_MANIFEST,
] as const;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY_SEGMENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export type AgentBackupRestoreExactImagePlatform = "linux/amd64" | "linux/arm64";

export interface AgentBackupRestoreExactImagePlatformInput {
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly platform: AgentBackupRestoreExactImagePlatform;
  readonly signal?: AbortSignal;
}

export interface AgentBackupRestoreExactImagePlatformAuthority {
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly imagePlatformDigest: string;
  readonly platform: AgentBackupRestoreExactImagePlatform;
}

export interface AgentBackupRestoreExactImagePlatformOptions {
  readonly fetchFn?: typeof fetch;
  /** One deadline shared by token, manifests, and config fetches. */
  readonly timeoutMs?: number;
}

export type AgentBackupRestoreExactImagePlatformErrorCode =
  | "IMAGE_REFERENCE_INVALID"
  | "IMAGE_AUTHORITY_MISMATCH"
  | "IMAGE_DIGEST_INVALID"
  | "PLATFORM_INVALID"
  | "REGISTRY_TIMEOUT"
  | "REGISTRY_TRANSPORT_ERROR"
  | "REGISTRY_HTTP_ERROR"
  | "REGISTRY_RESPONSE_TOO_LARGE"
  | "REGISTRY_RESPONSE_INVALID"
  | "REGISTRY_MEDIA_TYPE_INVALID"
  | "REGISTRY_DIGEST_MISMATCH"
  | "REGISTRY_SIZE_MISMATCH"
  | "REGISTRY_TOKEN_INVALID"
  | "PLATFORM_NOT_FOUND"
  | "PLATFORM_AMBIGUOUS"
  | "PLATFORM_CONFIG_MISMATCH";

export class AgentBackupRestoreExactImagePlatformError extends Error {
  readonly code: AgentBackupRestoreExactImagePlatformErrorCode;

  constructor(
    code: AgentBackupRestoreExactImagePlatformErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentBackupRestoreExactImagePlatformError";
    this.code = code;
  }
}

interface CanonicalImageAuthority {
  readonly repository: string;
  readonly imageReference: string;
  readonly imageDigest: string;
}

interface RegistryObjectResponse {
  readonly response: Response;
  readonly body: Uint8Array;
}

interface ManifestDescriptor {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
  readonly platform?: Readonly<{
    os: string;
    architecture: string;
  }>;
}

function resolutionError(
  code: AgentBackupRestoreExactImagePlatformErrorCode,
  message: string,
  cause?: unknown,
): AgentBackupRestoreExactImagePlatformError {
  return new AgentBackupRestoreExactImagePlatformError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalImageAuthority(
  imageReference: string,
  imageDigest: string,
): CanonicalImageAuthority {
  if (!SHA256_DIGEST.test(imageDigest)) {
    throw resolutionError("IMAGE_DIGEST_INVALID", "Restore image digest is not canonical sha256");
  }
  if (
    imageReference.length === 0 ||
    imageReference !== imageReference.trim() ||
    /\s/.test(imageReference) ||
    !imageReference.startsWith("ghcr.io/")
  ) {
    throw resolutionError(
      "IMAGE_REFERENCE_INVALID",
      "Restore image reference must use canonical ghcr.io authority",
    );
  }

  const locator = imageReference.slice("ghcr.io/".length);
  const atIndex = locator.indexOf("@");
  let repository: string;
  if (atIndex !== -1) {
    if (atIndex !== locator.lastIndexOf("@")) {
      throw resolutionError(
        "IMAGE_REFERENCE_INVALID",
        "Restore image reference has extra authority",
      );
    }
    const repositoryLocator = locator.slice(0, atIndex);
    const lastSlash = repositoryLocator.lastIndexOf("/");
    const tagIndex = repositoryLocator.lastIndexOf(":");
    if (tagIndex > lastSlash) {
      const tag = repositoryLocator.slice(tagIndex + 1);
      if (!TAG.test(tag)) {
        throw resolutionError("IMAGE_REFERENCE_INVALID", "Restore image tag locator is invalid");
      }
      repository = repositoryLocator.slice(0, tagIndex);
    } else {
      repository = repositoryLocator;
    }
    const referenceDigest = locator.slice(atIndex + 1);
    if (!SHA256_DIGEST.test(referenceDigest)) {
      throw resolutionError(
        "IMAGE_REFERENCE_INVALID",
        "Digest-pinned restore image reference is not canonical",
      );
    }
    if (referenceDigest !== imageDigest) {
      throw resolutionError(
        "IMAGE_AUTHORITY_MISMATCH",
        "Restore image reference digest differs from database authority",
      );
    }
  } else {
    const lastSlash = locator.lastIndexOf("/");
    const tagIndex = locator.lastIndexOf(":");
    if (tagIndex <= lastSlash || tagIndex === locator.length - 1) {
      throw resolutionError(
        "IMAGE_REFERENCE_INVALID",
        "Restore image locator must include a tag or matching digest",
      );
    }
    repository = locator.slice(0, tagIndex);
    if (!TAG.test(locator.slice(tagIndex + 1))) {
      throw resolutionError("IMAGE_REFERENCE_INVALID", "Restore image tag locator is invalid");
    }
  }

  const repositorySegments = repository.split("/");
  if (
    repository.length > 255 ||
    repositorySegments.length < 2 ||
    repositorySegments.some((segment) => !REPOSITORY_SEGMENT.test(segment))
  ) {
    throw resolutionError(
      "IMAGE_REFERENCE_INVALID",
      "Restore image repository is not canonical lowercase GHCR authority",
    );
  }

  return Object.freeze({
    repository,
    imageReference: `ghcr.io/${repository}@${imageDigest}`,
    imageDigest,
  });
}

function validatePlatform(platform: string): AgentBackupRestoreExactImagePlatform {
  if (platform !== "linux/amd64" && platform !== "linux/arm64") {
    throw resolutionError("PLATFORM_INVALID", "Restore image platform is unsupported");
  }
  return platform;
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw resolutionError(
      "REGISTRY_RESPONSE_INVALID",
      "Restore image registry timeout is outside the bounded range",
    );
  }
  return timeoutMs;
}

function responseMediaType(response: Response): string | null {
  const value = response.headers.get("content-type");
  if (value === null) return null;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType && mediaType.length > 0 ? mediaType : null;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  context: string,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
      throw resolutionError(
        "REGISTRY_RESPONSE_INVALID",
        `${context} returned an invalid content length`,
      );
    }
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      throw resolutionError(
        "REGISTRY_RESPONSE_TOO_LARGE",
        `${context} exceeded its response bound`,
      );
    }
  }
  if (response.body === null) {
    throw resolutionError("REGISTRY_RESPONSE_INVALID", `${context} returned an empty body`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    totalBytes += next.value.byteLength;
    if (totalBytes > maxBytes) {
      try {
        await reader.cancel();
      } catch (error) {
        // error-policy:J6 the size failure remains authoritative; cancellation is
        // best-effort teardown, but its failure remains observable.
        logger.warn("[AgentBackupRestoreExactImagePlatform] Failed to cancel oversized body", {
          context,
          error,
        });
      }
      throw resolutionError(
        "REGISTRY_RESPONSE_TOO_LARGE",
        `${context} exceeded its response bound`,
      );
    }
    chunks.push(next.value);
  }
  if (totalBytes === 0) {
    throw resolutionError("REGISTRY_RESPONSE_INVALID", `${context} returned an empty body`);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseJsonObject(body: Uint8Array, context: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    parsed = JSON.parse(text);
  } catch (cause) {
    // error-policy:J3 untrusted registry bytes become an explicit invalid response.
    throw resolutionError("REGISTRY_RESPONSE_INVALID", `${context} is not valid UTF-8 JSON`, cause);
  }
  if (!isRecord(parsed)) {
    throw resolutionError("REGISTRY_RESPONSE_INVALID", `${context} is not a JSON object`);
  }
  return parsed;
}

function sha256Digest(body: Uint8Array): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function assertDigestHeader(response: Response, expectedDigest: string, context: string): void {
  if (response.headers.get("docker-content-digest") !== expectedDigest) {
    throw resolutionError(
      "REGISTRY_DIGEST_MISMATCH",
      `${context} returned a different Docker-Content-Digest`,
    );
  }
}

function assertBodyDigest(body: Uint8Array, expectedDigest: string, context: string): void {
  if (sha256Digest(body) !== expectedDigest) {
    throw resolutionError(
      "REGISTRY_DIGEST_MISMATCH",
      `${context} body differs from its content-addressed digest`,
    );
  }
}

function assertHttpSuccess(response: Response, context: string): void {
  if (!response.ok) {
    throw resolutionError("REGISTRY_HTTP_ERROR", `${context} failed with HTTP ${response.status}`);
  }
}

async function registryFetch(params: {
  fetchFn: typeof fetch;
  url: string;
  init: RequestInit;
  signal: AbortSignal;
  callerSignal?: AbortSignal;
  deadlineSignal: AbortSignal;
  maxBytes: number;
  context: string;
  allowedStatuses?: readonly number[];
  readBody?: boolean;
}): Promise<RegistryObjectResponse> {
  if (params.callerSignal?.aborted) throw params.callerSignal.reason;
  if (params.deadlineSignal.aborted) {
    throw resolutionError("REGISTRY_TIMEOUT", "Restore image registry deadline expired");
  }
  try {
    const response = await params.fetchFn(params.url, {
      ...params.init,
      redirect: params.init.redirect ?? "error",
      signal: params.signal,
    });
    if (params.allowedStatuses) {
      if (!params.allowedStatuses.includes(response.status)) {
        throw resolutionError(
          "REGISTRY_HTTP_ERROR",
          `${params.context} failed with HTTP ${response.status}`,
        );
      }
    } else {
      assertHttpSuccess(response, params.context);
    }
    let body: Uint8Array;
    if (params.readBody === false) {
      await response.body?.cancel();
      body = new Uint8Array(0);
    } else {
      body = await readBoundedBody(response, params.maxBytes, params.context);
    }
    if (params.callerSignal?.aborted) throw params.callerSignal.reason;
    if (params.deadlineSignal.aborted) {
      throw resolutionError("REGISTRY_TIMEOUT", "Restore image registry deadline expired");
    }
    params.signal.throwIfAborted();
    return { response, body };
  } catch (cause) {
    // error-policy:J2 preserve caller aborts and add typed registry context with cause.
    if (params.callerSignal?.aborted) throw params.callerSignal.reason;
    if (params.deadlineSignal.aborted) {
      throw resolutionError("REGISTRY_TIMEOUT", "Restore image registry deadline expired", cause);
    }
    if (cause instanceof AgentBackupRestoreExactImagePlatformError) throw cause;
    throw resolutionError("REGISTRY_TRANSPORT_ERROR", `${params.context} transport failed`, cause);
  }
}

function requireGhcrConfigBlobRedirect(response: Response, expectedDigest: string): string {
  const location = response.headers.get("location");
  if (!location) {
    throw resolutionError(
      "REGISTRY_RESPONSE_INVALID",
      "GHCR config blob response omitted its CDN redirect",
    );
  }
  let url: URL;
  try {
    url = new URL(location);
  } catch (cause) {
    // error-policy:J3 an untrusted Location becomes an explicit invalid response.
    throw resolutionError(
      "REGISTRY_RESPONSE_INVALID",
      "GHCR config blob redirect is not an absolute URL",
      cause,
    );
  }
  const pathSegments = url.pathname.split("/");
  const expectedPathSuffix = `/blobs/${expectedDigest}`;
  const hasSafePath =
    url.pathname.length > expectedPathSuffix.length &&
    url.pathname.endsWith(expectedPathSuffix) &&
    pathSegments.slice(1).every((segment) => /^[A-Za-z0-9._~:-]+$/.test(segment));
  if (
    url.protocol !== "https:" ||
    url.hostname !== "pkg-containers.githubusercontent.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !hasSafePath
  ) {
    throw resolutionError(
      "REGISTRY_RESPONSE_INVALID",
      "GHCR config blob redirect left its exact HTTPS CDN digest authority",
    );
  }
  return url.toString();
}

function manifestUrl(repository: string, digest: string): string {
  const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
  return `https://ghcr.io/v2/${encodedRepository}/manifests/${encodeURIComponent(digest)}`;
}

function blobUrl(repository: string, digest: string): string {
  const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
  return `https://ghcr.io/v2/${encodedRepository}/blobs/${encodeURIComponent(digest)}`;
}

function tokenUrl(repository: string): string {
  const url = new URL("https://ghcr.io/token");
  url.searchParams.set("scope", `repository:${repository}:pull`);
  url.searchParams.set("service", "ghcr.io");
  return url.toString();
}

function requireToken(body: Uint8Array, response: Response): string {
  if (responseMediaType(response) !== "application/json") {
    throw resolutionError(
      "REGISTRY_MEDIA_TYPE_INVALID",
      "GHCR token response has an invalid media type",
    );
  }
  const tokenDocument = parseJsonObject(body, "GHCR token response");
  const token = tokenDocument.token;
  if (typeof token !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(token)) {
    throw resolutionError("REGISTRY_TOKEN_INVALID", "GHCR token response omitted a safe token");
  }
  return token;
}

function requireManifestDocument(params: {
  body: Uint8Array;
  response: Response;
  expectedDigest: string;
  expectedMediaType?: string;
  context: string;
}): Readonly<{ mediaType: string; document: Record<string, unknown> }> {
  assertDigestHeader(params.response, params.expectedDigest, params.context);
  assertBodyDigest(params.body, params.expectedDigest, params.context);
  const headerMediaType = responseMediaType(params.response);
  const document = parseJsonObject(params.body, params.context);
  const mediaType = document.mediaType;
  if (
    typeof mediaType !== "string" ||
    (!INDEX_MEDIA_TYPES.has(mediaType) && !MANIFEST_MEDIA_TYPES.has(mediaType)) ||
    headerMediaType !== mediaType ||
    (params.expectedMediaType !== undefined && mediaType !== params.expectedMediaType) ||
    document.schemaVersion !== 2
  ) {
    throw resolutionError(
      "REGISTRY_MEDIA_TYPE_INVALID",
      `${params.context} has an invalid or inconsistent manifest media type`,
    );
  }
  return { mediaType, document };
}

function requireDescriptor(
  value: unknown,
  context: string,
  maxBytes: number,
  requirePlatform: boolean,
): ManifestDescriptor {
  if (!isRecord(value)) {
    throw resolutionError("REGISTRY_RESPONSE_INVALID", `${context} is not a descriptor`);
  }
  const mediaType = value.mediaType;
  const digest = value.digest;
  const size = value.size;
  if (
    typeof mediaType !== "string" ||
    typeof digest !== "string" ||
    !SHA256_DIGEST.test(digest) ||
    !Number.isSafeInteger(size) ||
    (size as number) < 1 ||
    (size as number) > maxBytes
  ) {
    throw resolutionError("REGISTRY_RESPONSE_INVALID", `${context} is not content-addressed`);
  }

  let platform: ManifestDescriptor["platform"];
  if (requirePlatform) {
    if (!isRecord(value.platform)) {
      throw resolutionError("REGISTRY_RESPONSE_INVALID", `${context} omitted its platform`);
    }
    const os = value.platform.os;
    const architecture = value.platform.architecture;
    if (
      typeof os !== "string" ||
      os.length === 0 ||
      typeof architecture !== "string" ||
      architecture.length === 0
    ) {
      throw resolutionError("REGISTRY_RESPONSE_INVALID", `${context} has an invalid platform`);
    }
    platform = Object.freeze({ os, architecture });
  }

  return Object.freeze({
    mediaType,
    digest,
    size: size as number,
    ...(platform ? { platform } : {}),
  });
}

function selectPlatformDescriptor(
  document: Readonly<Record<string, unknown>>,
  platform: AgentBackupRestoreExactImagePlatform,
): ManifestDescriptor {
  if (!Array.isArray(document.manifests) || document.manifests.length === 0) {
    throw resolutionError("REGISTRY_RESPONSE_INVALID", "Image index omitted child manifests");
  }
  if (document.manifests.length > AGENT_BACKUP_RESTORE_EXACT_IMAGE_INDEX_MAX_DESCRIPTORS) {
    throw resolutionError("REGISTRY_RESPONSE_TOO_LARGE", "Image index has too many descriptors");
  }
  const [expectedOs, expectedArchitecture] = platform.split("/");
  const descriptors = document.manifests.map((value, index) => {
    const descriptor = requireDescriptor(
      value,
      `Image index descriptor ${index}`,
      AGENT_BACKUP_RESTORE_EXACT_IMAGE_MANIFEST_MAX_BYTES,
      true,
    );
    if (!MANIFEST_MEDIA_TYPES.has(descriptor.mediaType)) {
      throw resolutionError(
        "REGISTRY_MEDIA_TYPE_INVALID",
        `Image index descriptor ${index} is not an image manifest`,
      );
    }
    return descriptor;
  });
  const candidates = descriptors.filter(
    (descriptor) =>
      descriptor.platform?.os === expectedOs &&
      descriptor.platform.architecture === expectedArchitecture,
  );
  if (candidates.length === 0) {
    throw resolutionError("PLATFORM_NOT_FOUND", `Image index does not contain ${platform}`);
  }
  if (candidates.length !== 1) {
    throw resolutionError("PLATFORM_AMBIGUOUS", `Image index contains ambiguous ${platform}`);
  }
  return candidates[0] as ManifestDescriptor;
}

function requireConfigDescriptor(
  document: Readonly<Record<string, unknown>>,
  manifestMediaType: string,
): ManifestDescriptor {
  if (!Array.isArray(document.layers)) {
    throw resolutionError("REGISTRY_RESPONSE_INVALID", "Child image manifest omitted layers");
  }
  const descriptor = requireDescriptor(
    document.config,
    "Child image config descriptor",
    AGENT_BACKUP_RESTORE_EXACT_IMAGE_CONFIG_MAX_BYTES,
    false,
  );
  const expectedConfigMediaType =
    manifestMediaType === OCI_IMAGE_MANIFEST ? OCI_IMAGE_CONFIG : DOCKER_IMAGE_CONFIG;
  if (descriptor.mediaType !== expectedConfigMediaType) {
    throw resolutionError(
      "REGISTRY_MEDIA_TYPE_INVALID",
      "Child image config descriptor has an invalid media type",
    );
  }
  return descriptor;
}

function assertExactSize(body: Uint8Array, expectedSize: number, context: string): void {
  if (body.byteLength !== expectedSize) {
    throw resolutionError("REGISTRY_SIZE_MISMATCH", `${context} differs from its descriptor size`);
  }
}

/**
 * Resolve the exact, platform-specific child of a DB-authorized GHCR image
 * generation. Throws on every unresolved or ambiguous state.
 */
export async function resolveAgentBackupRestoreExactImagePlatform(
  input: Readonly<AgentBackupRestoreExactImagePlatformInput>,
  options: Readonly<AgentBackupRestoreExactImagePlatformOptions> = {},
): Promise<Readonly<AgentBackupRestoreExactImagePlatformAuthority>> {
  const authority = canonicalImageAuthority(input.imageReference, input.imageDigest);
  const platform = validatePlatform(input.platform);
  const timeoutMs = validateTimeout(
    options.timeoutMs ?? AGENT_BACKUP_RESTORE_EXACT_IMAGE_FETCH_TIMEOUT_MS,
  );
  const fetchFn = options.fetchFn ?? fetch;
  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, deadlineSignal]) : deadlineSignal;

  const commonFetch = {
    fetchFn,
    signal,
    ...(input.signal ? { callerSignal: input.signal } : {}),
    deadlineSignal,
  };
  const tokenResponse = await registryFetch({
    ...commonFetch,
    url: tokenUrl(authority.repository),
    init: {
      method: "GET",
      headers: { Accept: "application/json" },
    },
    maxBytes: AGENT_BACKUP_RESTORE_EXACT_IMAGE_TOKEN_MAX_BYTES,
    context: "GHCR token request",
  });
  const token = requireToken(tokenResponse.body, tokenResponse.response);
  const manifestHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: ACCEPTED_MANIFEST_MEDIA_TYPES.join(", "),
  };

  const generationResponse = await registryFetch({
    ...commonFetch,
    url: manifestUrl(authority.repository, authority.imageDigest),
    init: { method: "GET", headers: manifestHeaders },
    maxBytes: AGENT_BACKUP_RESTORE_EXACT_IMAGE_MANIFEST_MAX_BYTES,
    context: "GHCR generation manifest",
  });
  const generation = requireManifestDocument({
    ...generationResponse,
    expectedDigest: authority.imageDigest,
    context: "GHCR generation manifest",
  });

  const selectedDescriptor = INDEX_MEDIA_TYPES.has(generation.mediaType)
    ? selectPlatformDescriptor(generation.document, platform)
    : Object.freeze({
        mediaType: generation.mediaType,
        digest: authority.imageDigest,
        size: generationResponse.body.byteLength,
      });

  const childResponse = await registryFetch({
    ...commonFetch,
    url: manifestUrl(authority.repository, selectedDescriptor.digest),
    init: { method: "GET", headers: manifestHeaders },
    maxBytes: AGENT_BACKUP_RESTORE_EXACT_IMAGE_MANIFEST_MAX_BYTES,
    context: "GHCR platform child manifest",
  });
  assertExactSize(childResponse.body, selectedDescriptor.size, "GHCR platform child manifest");
  const child = requireManifestDocument({
    ...childResponse,
    expectedDigest: selectedDescriptor.digest,
    expectedMediaType: selectedDescriptor.mediaType,
    context: "GHCR platform child manifest",
  });
  if (!MANIFEST_MEDIA_TYPES.has(child.mediaType)) {
    throw resolutionError(
      "REGISTRY_MEDIA_TYPE_INVALID",
      "Selected platform child is not an image manifest",
    );
  }

  const configDescriptor = requireConfigDescriptor(child.document, child.mediaType);
  const configRedirect = await registryFetch({
    ...commonFetch,
    url: blobUrl(authority.repository, configDescriptor.digest),
    init: {
      method: "GET",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: `${configDescriptor.mediaType}, ${OCTET_STREAM}`,
      },
    },
    maxBytes: AGENT_BACKUP_RESTORE_EXACT_IMAGE_CONFIG_MAX_BYTES,
    context: "GHCR platform config blob redirect",
    allowedStatuses: [302, 303, 307, 308],
    readBody: false,
  });
  const configResponse = await registryFetch({
    ...commonFetch,
    url: requireGhcrConfigBlobRedirect(configRedirect.response, configDescriptor.digest),
    init: {
      method: "GET",
      headers: { Accept: `${configDescriptor.mediaType}, ${OCTET_STREAM}` },
    },
    maxBytes: AGENT_BACKUP_RESTORE_EXACT_IMAGE_CONFIG_MAX_BYTES,
    context: "GHCR platform config CDN blob",
  });
  assertExactSize(configResponse.body, configDescriptor.size, "GHCR platform config CDN blob");
  assertBodyDigest(configResponse.body, configDescriptor.digest, "GHCR platform config CDN blob");
  const configMediaType = responseMediaType(configResponse.response);
  if (configMediaType !== configDescriptor.mediaType && configMediaType !== OCTET_STREAM) {
    throw resolutionError(
      "REGISTRY_MEDIA_TYPE_INVALID",
      "GHCR platform config blob has an invalid media type",
    );
  }
  const config = parseJsonObject(configResponse.body, "GHCR platform config CDN blob");
  const [expectedOs, expectedArchitecture] = platform.split("/");
  if (config.os !== expectedOs || config.architecture !== expectedArchitecture) {
    throw resolutionError(
      "PLATFORM_CONFIG_MISMATCH",
      "Image config does not prove the reserved node platform",
    );
  }

  input.signal?.throwIfAborted();
  if (deadlineSignal.aborted) {
    throw resolutionError("REGISTRY_TIMEOUT", "Restore image registry deadline expired");
  }

  return Object.freeze({
    imageReference: authority.imageReference,
    imageDigest: authority.imageDigest,
    imagePlatformDigest: selectedDescriptor.digest,
    platform,
  });
}
