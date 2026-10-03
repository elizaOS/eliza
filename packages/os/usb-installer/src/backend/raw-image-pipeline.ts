// Safe, streaming raw.zst preparation/write/readback foundation.
import { createHash, type KeyObject } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  Readable,
  Transform,
  type TransformCallback,
  Writable,
} from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createZstdDecompress } from "node:zlib";
import {
  assertEd25519Signature,
  loadPinnedEd25519PublicKey,
  publicKeyFingerprint,
} from "./ed25519-trust";
import type { ReleaseFetcher } from "./release-manifest";
import type { ElizaOsImage } from "./types";
import { hasTrustedChecksum } from "./write-safety";

const DEFAULT_MAX_COMPRESSED_BYTES = 32 * 1024 ** 3;
const DEFAULT_MAX_EXPANDED_BYTES = 128 * 1024 ** 3;
const MAX_ARTIFACT_SIGNATURE_BYTES = 1024;
const TEMP_PREFIX = "elizaos-raw-";

type CanonicalRawImage = ElizaOsImage &
  Required<
    Pick<
      ElizaOsImage,
      | "sequence"
      | "compressedSize"
      | "expandedSize"
      | "sha256Compressed"
      | "sha256Expanded"
      | "signatureUrl"
      | "minDeviceBytes"
      | "format"
    >
  >;

export interface RawImageTarget {
  stableId: string;
  capacityBytes: number;
  openWriteStream(): Writable;
  openReadbackStream(byteLength: number): Readable;
  sync(): Promise<void>;
}

export interface RawImagePipelineOptions {
  publicKey?: KeyObject;
  fetcher?: ReleaseFetcher;
  signal?: AbortSignal;
  temporaryRoot?: string;
  maximumCompressedBytes?: number;
  maximumExpandedBytes?: number;
  createDecompressor?: () => Transform;
  onProgress?: (
    phase: "download" | "decompress-write" | "readback",
    completedBytes: number,
    totalBytes: number,
  ) => void;
}

export interface RawImageWriteReceipt {
  targetStableId: string;
  compressedBytes: number;
  expandedBytes: number;
  sha256Compressed: string;
  sha256Expanded: string;
  sha256Readback: string;
  releaseKeyFingerprint: string;
}

class HashExactTransform extends Transform {
  readonly hash = createHash("sha256");
  bytes = 0;

  constructor(
    private readonly expectedBytes: number,
    private readonly phase: Parameters<
      NonNullable<RawImagePipelineOptions["onProgress"]>
    >[0],
    private readonly onProgress?: RawImagePipelineOptions["onProgress"],
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.expectedBytes) {
      callback(
        new Error(
          `${this.phase} exceeded the signed size ${this.expectedBytes} bytes.`,
        ),
      );
      return;
    }
    this.hash.update(chunk);
    this.onProgress?.(this.phase, this.bytes, this.expectedBytes);
    callback(null, chunk);
  }

  digest(): string {
    if (this.bytes !== this.expectedBytes) {
      throw new Error(
        `${this.phase} produced ${this.bytes} bytes; signed metadata requires exactly ${this.expectedBytes}.`,
      );
    }
    return this.hash.digest("hex");
  }
}

function canonicalRawImage(image: ElizaOsImage): CanonicalRawImage {
  const httpsSuffix = (value: string | undefined, suffix: string): boolean => {
    if (!value) return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.pathname.endsWith(suffix);
    } catch {
      return false;
    }
  };
  if (
    image.format !== "raw.zst" ||
    !Number.isSafeInteger(image.sequence) ||
    Number(image.sequence) <= 0 ||
    !Number.isSafeInteger(image.compressedSize) ||
    Number(image.compressedSize) <= 0 ||
    !Number.isSafeInteger(image.expandedSize) ||
    Number(image.expandedSize) < Number(image.compressedSize) ||
    !Number.isSafeInteger(image.minDeviceBytes) ||
    Number(image.minDeviceBytes) < Number(image.expandedSize) ||
    !hasTrustedChecksum(image.sha256Compressed ?? "") ||
    !hasTrustedChecksum(image.sha256Expanded ?? "") ||
    image.sha256Compressed === image.sha256Expanded ||
    image.checksumSha256 !== image.sha256Compressed ||
    image.sizeBytes !== image.compressedSize ||
    image.minUsbSizeBytes !== image.minDeviceBytes ||
    !httpsSuffix(image.url, ".raw.zst") ||
    !httpsSuffix(image.signatureUrl, ".sig")
  ) {
    throw new Error(
      "Image is not a complete canonical raw.zst release artifact.",
    );
  }
  return image as CanonicalRawImage;
}

function assertPipelineBounds(
  image: CanonicalRawImage,
  target: RawImageTarget,
  options: RawImagePipelineOptions,
): void {
  const maxCompressed =
    options.maximumCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES;
  const maxExpanded =
    options.maximumExpandedBytes ?? DEFAULT_MAX_EXPANDED_BYTES;
  if (
    !Number.isSafeInteger(maxCompressed) ||
    !Number.isSafeInteger(maxExpanded) ||
    maxCompressed <= 0 ||
    maxExpanded <= 0
  ) {
    throw new Error(
      "Raw image pipeline bounds must be positive safe integers.",
    );
  }
  if (
    image.compressedSize > maxCompressed ||
    image.expandedSize > maxExpanded
  ) {
    throw new Error(
      "Signed raw image size exceeds configured pipeline bounds.",
    );
  }
  if (!target.stableId.trim())
    throw new Error("Raw image target requires a stable identity.");
  if (
    !Number.isSafeInteger(target.capacityBytes) ||
    target.capacityBytes < image.minDeviceBytes ||
    target.capacityBytes < image.expandedSize
  ) {
    throw new Error(
      "Raw image target does not satisfy the signed minimum device size.",
    );
  }
}

async function boundedResponseBytes(
  response: Response,
  label: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!response.ok)
    throw new Error(`${label} request failed with HTTP ${response.status}.`);
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

function artifactSignaturePayload(image: CanonicalRawImage): Uint8Array {
  return new TextEncoder().encode(
    [
      "elizaOS-artifact-v1",
      image.url,
      image.architecture,
      String(image.sequence),
      String(image.compressedSize),
      String(image.expandedSize),
      image.sha256Compressed,
      image.sha256Expanded,
      "",
    ].join("\n"),
  );
}

export function createArtifactSignaturePayload(
  image: ElizaOsImage,
): Uint8Array {
  return artifactSignaturePayload(canonicalRawImage(image));
}

async function safeCleanup(
  workDirectory: string,
  temporaryRoot: string,
): Promise<void> {
  const resolvedRoot = path.resolve(temporaryRoot);
  const resolvedWork = path.resolve(workDirectory);
  if (
    path.dirname(resolvedWork) !== resolvedRoot ||
    !path.basename(resolvedWork).startsWith(TEMP_PREFIX)
  ) {
    throw new Error(
      "Refusing to clean an unexpected raw image temporary path.",
    );
  }
  await fs.rm(resolvedWork, { recursive: true, force: true });
}

export async function writeVerifiedRawImage(
  sourceImage: ElizaOsImage,
  target: RawImageTarget,
  options: RawImagePipelineOptions = {},
): Promise<RawImageWriteReceipt> {
  options.signal?.throwIfAborted();
  const image = canonicalRawImage(sourceImage);
  assertPipelineBounds(image, target, options);
  const publicKey = options.publicKey ?? loadPinnedEd25519PublicKey();
  const fetcher = options.fetcher ?? fetch;
  const temporaryRoot = path.resolve(options.temporaryRoot ?? tmpdir());
  await fs.mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const workDirectory = await fs.mkdtemp(path.join(temporaryRoot, TEMP_PREFIX));
  const compressedPath = path.join(workDirectory, "image.raw.zst");
  const requestInit: RequestInit = {
    redirect: "error",
    ...(options.signal ? { signal: options.signal } : {}),
  };

  try {
    const [imageResponse, signatureResponse] = await Promise.all([
      fetcher(image.url, requestInit),
      fetcher(image.signatureUrl, {
        ...requestInit,
        headers: { Accept: "application/octet-stream, text/plain" },
      }),
    ]);
    if (!imageResponse.ok) {
      throw new Error(
        `Raw image request failed with HTTP ${imageResponse.status}.`,
      );
    }
    const contentLength = imageResponse.headers.get("content-length");
    if (contentLength !== null) {
      const declaredLength = Number(contentLength);
      if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength !== image.compressedSize
      ) {
        throw new Error(
          "Raw image Content-Length does not match signed metadata.",
        );
      }
    }
    if (!imageResponse.body) throw new Error("Raw image response has no body.");
    const signatureBytes = await boundedResponseBytes(
      signatureResponse,
      "Raw image signature",
      MAX_ARTIFACT_SIGNATURE_BYTES,
    );
    assertEd25519Signature(
      artifactSignaturePayload(image),
      signatureBytes,
      publicKey,
      "Raw image descriptor",
    );
    const downloadHash = new HashExactTransform(
      image.compressedSize,
      "download",
      options.onProgress,
    );
    await pipeline(
      Readable.fromWeb(
        imageResponse.body as unknown as WebReadableStream<Uint8Array>,
      ),
      downloadHash,
      createWriteStream(compressedPath, { flags: "wx", mode: 0o600 }),
      { signal: options.signal },
    );
    const sha256Compressed = downloadHash.digest();
    if (sha256Compressed !== image.sha256Compressed) {
      throw new Error(
        "Downloaded raw image SHA-256 does not match signed metadata.",
      );
    }
    const expandedHash = new HashExactTransform(
      image.expandedSize,
      "decompress-write",
      options.onProgress,
    );
    await pipeline(
      createReadStream(compressedPath),
      (options.createDecompressor ?? createZstdDecompress)(),
      expandedHash,
      target.openWriteStream(),
      { signal: options.signal },
    );
    const sha256Expanded = expandedHash.digest();
    if (sha256Expanded !== image.sha256Expanded) {
      throw new Error(
        "Expanded raw image SHA-256 does not match signed metadata.",
      );
    }
    await target.sync();

    const readbackHash = new HashExactTransform(
      image.expandedSize,
      "readback",
      options.onProgress,
    );
    await pipeline(
      target.openReadbackStream(image.expandedSize),
      readbackHash,
      new Writable({ write: (_chunk, _encoding, callback) => callback() }),
      { signal: options.signal },
    );
    const sha256Readback = readbackHash.digest();
    if (sha256Readback !== image.sha256Expanded) {
      throw new Error(
        "Exact expanded-byte readback SHA-256 verification failed.",
      );
    }

    return {
      targetStableId: target.stableId,
      compressedBytes: downloadHash.bytes,
      expandedBytes: expandedHash.bytes,
      sha256Compressed,
      sha256Expanded,
      sha256Readback,
      releaseKeyFingerprint: publicKeyFingerprint(publicKey),
    };
  } finally {
    await safeCleanup(workDirectory, temporaryRoot);
  }
}
