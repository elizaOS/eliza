import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  createArtifactSignaturePayload,
  type RawImageTarget,
  writeVerifiedRawImage,
} from "../raw-image-pipeline";
import type { ElizaOsImage } from "../types";

const keyPair = generateKeyPairSync("ed25519");
const roots: string[] = [];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function zstd(bytes: Uint8Array): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from(bytes),
    createZstdCompress(),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  return Buffer.concat(chunks);
}

class MemoryTarget implements RawImageTarget {
  stableId = "memory:target-1";
  capacityBytes: number;
  bytes = Buffer.alloc(0);
  synced = false;

  constructor(
    capacityBytes: number,
    private readonly corruptReadback = false,
    private readonly shortReadback = false,
  ) {
    this.capacityBytes = capacityBytes;
  }

  openWriteStream(): Writable {
    const chunks: Buffer[] = [];
    return new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      final: (callback) => {
        this.bytes = Buffer.concat(chunks);
        callback();
      },
    });
  }

  openReadbackStream(byteLength: number): Readable {
    const requestedBytes = this.shortReadback ? byteLength - 1 : byteLength;
    const copy = Buffer.from(this.bytes.subarray(0, requestedBytes));
    if (this.corruptReadback && copy.length > 0) {
      copy[0] = copy.readUInt8(0) ^ 0xff;
    }
    return Readable.from(copy);
  }

  async sync(): Promise<void> {
    this.synced = true;
  }
}

async function fixture() {
  const expanded = Buffer.from("elizaOS raw image fixture\0".repeat(4096));
  const compressed = await zstd(expanded);
  const image: ElizaOsImage = {
    id: "elizaOS-1.0.0-x86_64-1",
    label: "elizaOS 1.0.0",
    version: "1.0.0",
    channel: "stable",
    architecture: "x86_64",
    buildId: "1",
    publishedAt: "2026-08-17T00:00:00.000Z",
    url: "https://example.test/elizaos.raw.zst",
    checksumSha256: sha256(compressed),
    sizeBytes: compressed.byteLength,
    minUsbSizeBytes: expanded.byteLength,
    manifestVersion: 1,
    signatureUrl: "https://example.test/elizaos.raw.zst.sig",
    schemaVersion: 1,
    product: "elizaOS",
    sequence: 1,
    expires: "2026-09-17T00:00:00.000Z",
    compressedSize: compressed.byteLength,
    expandedSize: expanded.byteLength,
    sha256Compressed: sha256(compressed),
    sha256Expanded: sha256(expanded),
    minDeviceBytes: expanded.byteLength,
    format: "raw.zst",
  };
  const signature = sign(
    null,
    createArtifactSignaturePayload(image),
    keyPair.privateKey,
  );
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith(".sig"))
      return new Response(Uint8Array.from(signature).buffer);
    return new Response(Uint8Array.from(compressed).buffer, {
      headers: { "content-length": String(compressed.byteLength) },
    });
  };
  const temporaryRoot = await fs.mkdtemp(
    path.join(tmpdir(), "eliza-pipeline-test-"),
  );
  roots.push(temporaryRoot);
  return { expanded, compressed, image, fetcher, temporaryRoot };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("verified raw.zst pipeline", () => {
  it("streams download, decompression, write, sync, and exact-byte readback", async () => {
    const data = await fixture();
    const target = new MemoryTarget(data.expanded.byteLength);
    const receipt = await writeVerifiedRawImage(data.image, target, {
      publicKey: keyPair.publicKey,
      fetcher: data.fetcher,
      temporaryRoot: data.temporaryRoot,
      maximumCompressedBytes: data.compressed.byteLength,
      maximumExpandedBytes: data.expanded.byteLength,
    });

    expect(target.synced).toBe(true);
    expect(target.bytes).toEqual(data.expanded);
    expect(receipt).toMatchObject({
      compressedBytes: data.compressed.byteLength,
      expandedBytes: data.expanded.byteLength,
      sha256Expanded: sha256(data.expanded),
      sha256Readback: sha256(data.expanded),
    });
    await expect(fs.readdir(data.temporaryRoot)).resolves.toEqual([]);
  }, 15_000);

  it("rejects a corrupt download and cleans its private temporary directory", async () => {
    const data = await fixture();
    const corrupt = Buffer.from(data.compressed);
    const last = corrupt.length - 1;
    corrupt[last] = corrupt.readUInt8(last) ^ 0xff;
    const fetcher = async (input: string | URL | Request) =>
      String(input).endsWith(".sig")
        ? data.fetcher(input)
        : new Response(Uint8Array.from(corrupt).buffer, {
            headers: { "content-length": String(corrupt.byteLength) },
          });
    await expect(
      writeVerifiedRawImage(
        data.image,
        new MemoryTarget(data.expanded.byteLength),
        {
          publicKey: keyPair.publicKey,
          fetcher,
          temporaryRoot: data.temporaryRoot,
        },
      ),
    ).rejects.toThrow("SHA-256");
    await expect(fs.readdir(data.temporaryRoot)).resolves.toEqual([]);
  });

  it("rejects an invalid artifact descriptor signature", async () => {
    const data = await fixture();
    const fetcher = async (input: string | URL | Request) =>
      String(input).endsWith(".sig")
        ? new Response(new Uint8Array(64).buffer)
        : data.fetcher(input);
    await expect(
      writeVerifiedRawImage(
        data.image,
        new MemoryTarget(data.expanded.byteLength),
        {
          publicKey: keyPair.publicKey,
          fetcher,
          temporaryRoot: data.temporaryRoot,
        },
      ),
    ).rejects.toThrow("signature verification failed");
    await expect(fs.readdir(data.temporaryRoot)).resolves.toEqual([]);
  });

  it("fails on readback corruption and on configured size bounds", async () => {
    const data = await fixture();
    await expect(
      writeVerifiedRawImage(
        data.image,
        new MemoryTarget(data.expanded.byteLength, true),
        {
          publicKey: keyPair.publicKey,
          fetcher: data.fetcher,
          temporaryRoot: data.temporaryRoot,
        },
      ),
    ).rejects.toThrow("readback SHA-256");

    await expect(
      writeVerifiedRawImage(
        data.image,
        new MemoryTarget(data.expanded.byteLength, false, true),
        {
          publicKey: keyPair.publicKey,
          fetcher: data.fetcher,
          temporaryRoot: data.temporaryRoot,
        },
      ),
    ).rejects.toThrow("signed metadata requires exactly");

    await expect(
      writeVerifiedRawImage(
        data.image,
        new MemoryTarget(data.expanded.byteLength),
        {
          publicKey: keyPair.publicKey,
          fetcher: data.fetcher,
          temporaryRoot: data.temporaryRoot,
          maximumExpandedBytes: data.expanded.byteLength - 1,
        },
      ),
    ).rejects.toThrow("exceeds configured pipeline bounds");
  });

  it("honors cancellation without leaving staged image data", async () => {
    const data = await fixture();
    const controller = new AbortController();
    let offset = 0;
    let cancelled = false;
    const fetcher = async (input: string | URL | Request) => {
      if (String(input).endsWith(".sig")) return data.fetcher(input);
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(streamController) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (cancelled) return;
            if (offset >= data.compressed.byteLength) {
              streamController.close();
              return;
            }
            streamController.enqueue(
              data.compressed.subarray(offset, offset + 1),
            );
            offset += 1;
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": String(data.compressed.byteLength) } },
      );
    };
    setTimeout(() => controller.abort(new Error("test cancellation")), 15);
    await expect(
      writeVerifiedRawImage(
        data.image,
        new MemoryTarget(data.expanded.byteLength),
        {
          publicKey: keyPair.publicKey,
          fetcher,
          temporaryRoot: data.temporaryRoot,
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow(/aborted/i);
    await expect(fs.readdir(data.temporaryRoot)).resolves.toEqual([]);
  });
});
