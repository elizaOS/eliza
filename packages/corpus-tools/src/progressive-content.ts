/**
 * Generates deterministic, streamed large-content corpora for paging,
 * authorization, reassembly, and resource-usage tests. The manifest is the
 * mechanical oracle: it records stable source hashes and exact planted-canary
 * byte ranges without retaining source-sized buffers in memory.
 */

import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";

export const PROGRESSIVE_CONTENT_SCHEMA_VERSION =
  "elizaos.progressive-content.v1";
export const PROGRESSIVE_CONTENT_ANCHOR_TIME = "2026-01-01T00:00:00.000Z";

export type ProgressiveContentFamily =
  | "file"
  | "document"
  | "memory"
  | "email"
  | "attachment"
  | "tool-output";

export type ProgressiveContentProfile = "micro" | "pr" | "nightly" | "release";

export type ProgressiveContentFormat =
  | "lf-lines"
  | "crlf-lines"
  | "no-final-newline"
  | "single-line"
  | "minified-json-like"
  | "invalid-utf8";

export interface ProgressiveContentCanary {
  readonly label: "beginning" | "boundary" | "middle" | "end";
  readonly text: string;
  readonly byteStart: number;
  readonly byteEnd: number;
}

export interface ProgressiveContentObject {
  readonly id: string;
  readonly family: ProgressiveContentFamily;
  readonly format: ProgressiveContentFormat;
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sourceSha256: string;
  readonly revision: string;
  readonly authorizationScope: string;
  readonly canaries: readonly ProgressiveContentCanary[];
}

export interface ProgressiveContentManifest {
  readonly schemaVersion: typeof PROGRESSIVE_CONTENT_SCHEMA_VERSION;
  readonly generatorRevision: string;
  readonly rootSeed: string;
  readonly anchorTime: typeof PROGRESSIVE_CONTENT_ANCHOR_TIME;
  readonly profile: ProgressiveContentProfile;
  readonly objects: readonly ProgressiveContentObject[];
  readonly logicalBytes: number;
  readonly manifestSha256: string;
}

interface ProfileShape {
  readonly counts: Readonly<Record<ProgressiveContentFamily, number>>;
  readonly baseBytes: Readonly<Record<ProgressiveContentFamily, number>>;
}

const PROFILE_SHAPES: Readonly<
  Record<ProgressiveContentProfile, ProfileShape>
> = {
  micro: {
    counts: {
      file: 4,
      document: 4,
      memory: 4,
      email: 3,
      attachment: 3,
      "tool-output": 2,
    },
    baseBytes: {
      file: 32 * 1024,
      document: 24 * 1024,
      memory: 8 * 1024,
      email: 16 * 1024,
      attachment: 24 * 1024,
      "tool-output": 32 * 1024,
    },
  },
  pr: {
    counts: {
      file: 32,
      document: 32,
      memory: 2_000,
      email: 128,
      attachment: 32,
      "tool-output": 16,
    },
    baseBytes: {
      file: 192 * 1024,
      document: 128 * 1024,
      memory: 8 * 1024,
      email: 16 * 1024,
      attachment: 48 * 1024,
      "tool-output": 128 * 1024,
    },
  },
  nightly: {
    counts: {
      file: 1_250,
      document: 1_250,
      memory: 100_000,
      email: 10_000,
      attachment: 2_000,
      "tool-output": 500,
    },
    baseBytes: {
      file: 128 * 1024,
      document: 96 * 1024,
      memory: 4 * 1024,
      email: 16 * 1024,
      attachment: 48 * 1024,
      "tool-output": 96 * 1024,
    },
  },
  release: {
    counts: {
      file: 12_500,
      document: 12_500,
      memory: 1_000_000,
      email: 100_000,
      attachment: 10_000,
      "tool-output": 15_000,
    },
    baseBytes: {
      file: 160 * 1024,
      document: 128 * 1024,
      memory: 4 * 1024,
      email: 16 * 1024,
      attachment: 64 * 1024,
      "tool-output": 128 * 1024,
    },
  },
};

const FAMILY_ORDER: readonly ProgressiveContentFamily[] = [
  "file",
  "document",
  "memory",
  "email",
  "attachment",
  "tool-output",
];

const FORMAT_ORDER: readonly ProgressiveContentFormat[] = [
  "lf-lines",
  "crlf-lines",
  "no-final-newline",
  "single-line",
  "minified-json-like",
  "invalid-utf8",
];

/** Exact transport, preview, historic-cap, and large-source boundaries. */
export const PROGRESSIVE_CONTENT_BOUNDARY_BYTES = [
  0,
  1,
  4_095,
  4_096,
  4_097,
  9_999,
  10_000,
  10_001,
  32_767,
  32_768,
  32_769,
  50 * 1024 - 1,
  50 * 1024,
  50 * 1024 + 1,
  128 * 1024 - 1,
  128 * 1024,
  128 * 1024 + 1,
  256 * 1024 - 1,
  256 * 1024,
  256 * 1024 + 1,
  1024 * 1024,
  10 * 1024 * 1024,
] as const;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function progressiveContentObjectId(
  rootSeed: string,
  family: ProgressiveContentFamily,
  index: number,
): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError(
      "progressive content index must be a nonnegative safe integer",
    );
  }
  return sha256(
    `${PROGRESSIVE_CONTENT_SCHEMA_VERSION}:${rootSeed}:${family}:${index}`,
  ).slice(0, 32);
}

function objectByteLength(
  shape: ProfileShape,
  family: ProgressiveContentFamily,
  index: number,
  profile: ProgressiveContentProfile,
) {
  const base = shape.baseBytes[family];
  const boundaryCases =
    profile === "micro"
      ? PROGRESSIVE_CONTENT_BOUNDARY_BYTES.slice(0, 9)
      : PROGRESSIVE_CONTENT_BOUNDARY_BYTES;
  if (index < boundaryCases.length) return boundaryCases[index] ?? base;
  return base + (index % 7) * 257;
}

function canariesFor(
  id: string,
  byteLength: number,
): ProgressiveContentCanary[] {
  const labels = ["beginning", "boundary", "middle", "end"] as const;
  const texts = labels.map((label) => `CANARY:${id}:${label}:世界:🧪`);
  const lengths = texts.map((text) => Buffer.byteLength(text));
  const preferred = [
    0,
    Math.min(10_000, Math.floor(byteLength / 3)),
    Math.floor(byteLength / 2),
  ];
  const starts = [
    preferred[0],
    preferred[1],
    preferred[2],
    Math.max(0, byteLength - (lengths[3] ?? 0)),
  ];
  const occupied: Array<{ start: number; end: number }> = [];
  return labels.flatMap((label, index) => {
    const text = texts[index] ?? "";
    const textLength = lengths[index] ?? 0;
    if (textLength > byteLength) return [];
    let start = starts[index] ?? 0;
    for (const prior of occupied) {
      if (start < prior.end && start + textLength > prior.start)
        start = prior.end;
    }
    if (start + textLength > byteLength) return [];
    occupied.push({ start, end: start + textLength });
    return [{ label, text, byteStart: start, byteEnd: start + textLength }];
  });
}

async function writeStreamedObject(
  absolutePath: string,
  byteLength: number,
  canaries: readonly ProgressiveContentCanary[],
  format: ProgressiveContentFormat,
): Promise<string> {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const handle = await open(absolutePath, "w", 0o600);
  const digest = createHash("sha256");
  const chunkBytes = 64 * 1024;
  try {
    for (let offset = 0; offset < byteLength; offset += chunkBytes) {
      const length = Math.min(chunkBytes, byteLength - offset);
      const chunk = Buffer.alloc(
        length,
        0x61 + (Math.floor(offset / chunkBytes) % 26),
      );
      for (let local = 0; local < length; local += 1) {
        const absolute = offset + local;
        if (format === "lf-lines" && absolute % 80 === 79) chunk[local] = 0x0a;
        if (format === "crlf-lines") {
          if (absolute % 80 === 78) chunk[local] = 0x0d;
          if (absolute % 80 === 79) chunk[local] = 0x0a;
        }
        if (format === "no-final-newline" && absolute % 80 === 79) {
          chunk[local] = 0x0a;
        }
        if (format === "minified-json-like") {
          const pattern = Buffer.from('{"key":"escaped\\nvalue","n":123},');
          chunk[local] = pattern[absolute % pattern.length] ?? 0x61;
        }
      }
      if (
        format === "no-final-newline" &&
        byteLength > 0 &&
        offset <= byteLength - 1 &&
        offset + length > byteLength - 1
      ) {
        chunk[byteLength - 1 - offset] = 0x7a;
      }
      if (format === "invalid-utf8" && byteLength > 256) {
        const invalidAt = 127;
        if (offset <= invalidAt && invalidAt < offset + length) {
          chunk[invalidAt - offset] = 0xff;
        }
      }
      for (const canary of canaries) {
        const source = Buffer.from(canary.text);
        const overlapStart = Math.max(offset, canary.byteStart);
        const overlapEnd = Math.min(offset + length, canary.byteEnd);
        if (overlapStart >= overlapEnd) continue;
        source.copy(
          chunk,
          overlapStart - offset,
          overlapStart - canary.byteStart,
          overlapEnd - canary.byteStart,
        );
      }
      await handle.write(chunk, 0, chunk.length, offset);
      digest.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

export async function generateProgressiveContentCorpus(options: {
  readonly outDir: string;
  readonly profile?: ProgressiveContentProfile;
  readonly rootSeed: string;
  readonly generatorRevision: string;
}): Promise<ProgressiveContentManifest> {
  const profile = options.profile ?? "micro";
  const shape = PROFILE_SHAPES[profile];
  if (!shape)
    throw new Error(`unsupported progressive content profile: ${profile}`);
  if (!options.rootSeed.trim())
    throw new Error("progressive content rootSeed is required");
  if (!options.generatorRevision.trim()) {
    throw new Error("progressive content generatorRevision is required");
  }

  const objects: ProgressiveContentObject[] = [];
  let objectOrdinal = 0;
  for (const family of FAMILY_ORDER) {
    for (let index = 0; index < shape.counts[family]; index += 1) {
      const id = progressiveContentObjectId(options.rootSeed, family, index);
      const byteLength = objectByteLength(shape, family, index, profile);
      const format =
        FORMAT_ORDER[objectOrdinal % FORMAT_ORDER.length] ?? "single-line";
      objectOrdinal += 1;
      const relativePath = path.posix.join("objects", family, `${id}.txt`);
      const canaries = canariesFor(id, byteLength);
      const sourceSha256 = await writeStreamedObject(
        path.join(options.outDir, relativePath),
        byteLength,
        canaries,
        format,
      );
      objects.push({
        id,
        family,
        format,
        relativePath,
        byteLength,
        sourceSha256,
        revision: sourceSha256,
        authorizationScope: `room:${sha256(`${options.rootSeed}:${family}`).slice(0, 16)}`,
        canaries,
      });
    }
  }

  const unsigned = {
    schemaVersion: PROGRESSIVE_CONTENT_SCHEMA_VERSION,
    generatorRevision: options.generatorRevision,
    rootSeed: options.rootSeed,
    anchorTime: PROGRESSIVE_CONTENT_ANCHOR_TIME,
    profile,
    objects,
    logicalBytes: objects.reduce(
      (total, object) => total + object.byteLength,
      0,
    ),
  } as const;
  const manifest: ProgressiveContentManifest = {
    ...unsigned,
    manifestSha256: sha256(canonicalJson(unsigned)),
  };
  await mkdir(options.outDir, { recursive: true });
  await writeFile(
    path.join(options.outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return manifest;
}
