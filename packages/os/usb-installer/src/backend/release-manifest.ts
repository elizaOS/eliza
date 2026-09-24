// Loads and validates the canonical signed mkosi raw-image release contract.
import type { KeyObject } from "node:crypto";
import {
  assertEd25519Signature,
  loadPinnedEd25519PublicKey,
} from "./ed25519-trust";
import {
  configuredReleaseSequenceStore,
  type ReleaseSequenceStore,
} from "./release-sequence-store";
import type { ElizaOsImage } from "./types";
import { hasTrustedChecksum } from "./write-safety";

export const DEFAULT_RELEASE_MANIFEST_URL =
  "https://download.elizaos.ai/os/releases/manifest.json";
export const RELEASE_MANIFEST_SIGNATURE_URL_ENV =
  "ELIZAOS_RELEASE_MANIFEST_SIGNATURE_URL";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const MINIMUM_RELEASE_DEVICE_BYTES = 32_000_000_000;

export interface ElizaOsReleaseArtifact {
  schemaVersion: 1;
  product: "elizaOS";
  version: string;
  channel: "stable" | "beta" | "nightly";
  sequence: number;
  expires: string;
  architecture: "x86_64" | "arm64" | "riscv64";
  url: string;
  compressedSize: number;
  expandedSize: number;
  sha256Compressed: string;
  sha256Expanded: string;
  signatureUrl: string;
  minDeviceBytes: number;
  publishedAt?: string;
}

export interface ElizaOsReleaseManifest {
  schemaVersion: 1;
  product: "elizaOS";
  artifacts: ElizaOsReleaseArtifact[];
}

export type ReleaseFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ReleaseTrustOptions {
  publicKey?: KeyObject;
  signatureUrl?: string;
  signal?: AbortSignal;
  sequenceStore?: ReleaseSequenceStore;
}

function httpsUrl(value: unknown, suffix?: string): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      (!suffix || parsed.pathname.endsWith(suffix))
    );
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

async function responseBytes(
  response: Response,
  label: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!response.ok) {
    throw new Error(`${label} request failed with HTTP ${response.status}.`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error(`${label} exceeds the ${maximumBytes}-byte limit.`);
  }
  if (!response.body) throw new Error(`${label} response has no body.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds the ${maximumBytes}-byte limit.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function canonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return (
    Number.isFinite(parsed) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  );
}

const artifactFields = new Set<keyof ElizaOsReleaseArtifact>([
  "schemaVersion",
  "product",
  "version",
  "channel",
  "sequence",
  "expires",
  "architecture",
  "url",
  "compressedSize",
  "expandedSize",
  "sha256Compressed",
  "sha256Expanded",
  "signatureUrl",
  "minDeviceBytes",
  "publishedAt",
]);

export function parseReleaseManifest(
  value: unknown,
  now = Date.now(),
): ElizaOsImage[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Release manifest must be an object.");
  }
  const envelope = value as Partial<ElizaOsReleaseManifest>;
  if (
    envelope.schemaVersion !== 1 ||
    envelope.product !== "elizaOS" ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "product", "artifacts"].includes(key),
    )
  ) {
    throw new Error("Release manifest envelope is unsupported.");
  }
  const records = Array.isArray(envelope.artifacts) ? envelope.artifacts : null;
  if (!records || records.length === 0) {
    throw new Error(
      "Release manifest must contain a non-empty artifacts array.",
    );
  }

  const ids = new Set<string>();
  return records.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error(`Release artifact ${index} must be an object.`);
    }
    const item = candidate as Partial<ElizaOsReleaseArtifact>;
    const fail = (message: string): never => {
      throw new Error(`Invalid release artifact ${index}: ${message}`);
    };
    if (item.schemaVersion !== 1 || item.product !== "elizaOS")
      fail("unsupported schemaVersion or product.");
    const unknown = Object.keys(candidate).filter(
      (key) => !artifactFields.has(key as keyof ElizaOsReleaseArtifact),
    );
    if (unknown.length > 0)
      fail(`unknown fields: ${unknown.sort().join(", ")}.`);
    if (
      typeof item.version !== "string" ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(item.version)
    )
      fail("version must be a semantic release version.");
    if (
      !(["stable", "beta", "nightly"] as const).includes(item.channel as never)
    )
      fail("channel is unsupported.");
    if (
      !(["x86_64", "arm64", "riscv64"] as const).includes(
        item.architecture as never,
      )
    )
      fail("architecture is unsupported.");
    if (!positiveInteger(item.sequence))
      fail("sequence must be a positive safe integer.");
    const expires = item.expires;
    const expiresAt = canonicalIsoTimestamp(expires)
      ? Date.parse(expires)
      : fail("expires must be a canonical ISO timestamp.");
    if (expiresAt <= now) fail("expires must be in the future.");
    if (!httpsUrl(item.url, ".raw.zst"))
      fail("url must be an HTTPS .raw.zst artifact.");
    if (!httpsUrl(item.signatureUrl, ".sig"))
      fail("signatureUrl must be an HTTPS .sig artifact.");
    if (
      !positiveInteger(item.compressedSize) ||
      !positiveInteger(item.expandedSize)
    )
      fail("image sizes must be positive integers.");
    const compressedSize = Number(item.compressedSize);
    const expandedSize = Number(item.expandedSize);
    if (expandedSize < compressedSize)
      fail("expandedSize cannot be smaller than compressedSize.");
    if (
      !positiveInteger(item.minDeviceBytes) ||
      item.minDeviceBytes < MINIMUM_RELEASE_DEVICE_BYTES ||
      item.minDeviceBytes < expandedSize
    )
      fail(
        "minDeviceBytes must satisfy the 32 GB product floor and expandedSize.",
      );
    if (
      !hasTrustedChecksum(item.sha256Compressed ?? "") ||
      !hasTrustedChecksum(item.sha256Expanded ?? "")
    )
      fail("both SHA-256 digests must be non-placeholder lowercase hashes.");
    if (item.sha256Compressed === item.sha256Expanded)
      fail("compressed and expanded digests must differ.");
    if (
      item.publishedAt !== undefined &&
      !canonicalIsoTimestamp(item.publishedAt)
    )
      fail("publishedAt must be a canonical ISO timestamp when present.");

    const artifact = item as ElizaOsReleaseArtifact;
    const id = `${artifact.product}-${artifact.version}-${artifact.architecture}-${artifact.sequence}`;
    if (ids.has(id)) fail(`duplicate release identity ${id}.`);
    ids.add(id);

    return {
      id,
      label: `elizaOS ${artifact.version}`,
      version: artifact.version,
      channel: artifact.channel,
      architecture: artifact.architecture,
      buildId: String(artifact.sequence),
      publishedAt: artifact.publishedAt ?? new Date(expiresAt).toISOString(),
      url: artifact.url,
      checksumSha256: artifact.sha256Compressed,
      sizeBytes: artifact.compressedSize,
      minUsbSizeBytes: artifact.minDeviceBytes,
      manifestVersion: 1,
      signatureUrl: artifact.signatureUrl,
      schemaVersion: 1,
      product: "elizaOS",
      sequence: artifact.sequence,
      expires: new Date(expiresAt).toISOString(),
      compressedSize: artifact.compressedSize,
      expandedSize: artifact.expandedSize,
      sha256Compressed: artifact.sha256Compressed,
      sha256Expanded: artifact.sha256Expanded,
      minDeviceBytes: artifact.minDeviceBytes,
      format: "raw.zst",
    };
  });
}

export async function fetchReleaseImages(
  manifestUrl = process.env.ELIZAOS_RELEASE_MANIFEST_URL ??
    DEFAULT_RELEASE_MANIFEST_URL,
  fetcher: ReleaseFetcher = fetch,
  now = Date.now(),
  trust: ReleaseTrustOptions = {},
): Promise<ElizaOsImage[]> {
  if (!httpsUrl(manifestUrl)) {
    throw new Error("ELIZAOS_RELEASE_MANIFEST_URL must be HTTPS.");
  }
  const publicKey = trust.publicKey ?? loadPinnedEd25519PublicKey();
  const sequenceStore = trust.sequenceStore ?? configuredReleaseSequenceStore();
  const signatureUrl =
    trust.signatureUrl ??
    process.env[RELEASE_MANIFEST_SIGNATURE_URL_ENV] ??
    `${manifestUrl}.sig`;
  if (!httpsUrl(signatureUrl, ".sig") || signatureUrl === manifestUrl) {
    throw new Error(
      "Release manifest signature URL must be a distinct HTTPS .sig URL.",
    );
  }
  const requestInit: RequestInit = {
    redirect: "error",
    ...(trust.signal ? { signal: trust.signal } : {}),
  };
  const [manifestResponse, signatureResponse] = await Promise.all([
    fetcher(manifestUrl, {
      ...requestInit,
      headers: { Accept: "application/json" },
    }),
    fetcher(signatureUrl, {
      ...requestInit,
      headers: { Accept: "application/octet-stream, text/plain" },
    }),
  ]);
  const [manifestBytes, signatureBytes] = await Promise.all([
    responseBytes(manifestResponse, "Release manifest", MAX_MANIFEST_BYTES),
    responseBytes(
      signatureResponse,
      "Release manifest signature",
      MAX_SIGNATURE_BYTES,
    ),
  ]);
  assertEd25519Signature(
    manifestBytes,
    signatureBytes,
    publicKey,
    "Release manifest",
  );
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      manifestBytes,
    );
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Verified release manifest is not valid UTF-8 JSON: ${String(error)}`,
    );
  }
  const images = parseReleaseManifest(parsed, now);
  const sequences: Record<string, number> = {};
  for (const image of images) {
    const sequence = image.sequence;
    if (!Number.isSafeInteger(sequence) || Number(sequence) <= 0) {
      throw new Error("Verified release manifest is missing a valid sequence.");
    }
    const key = `${image.channel}/${image.architecture}`;
    sequences[key] = Math.max(sequences[key] ?? 0, Number(sequence));
  }
  for (const image of images) {
    const key = `${image.channel}/${image.architecture}`;
    if (image.sequence !== sequences[key]) {
      throw new Error(
        `Verified release manifest contains a rollback candidate for ${key}.`,
      );
    }
  }
  await sequenceStore.accept(sequences);
  return images;
}
