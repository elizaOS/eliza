/** Realizes corpus objects through bounded native ingestion or records explicit unwired-family blockers. */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type {
  ProgressiveContentFamily,
  ProgressiveContentManifest,
  ProgressiveContentObject,
} from "./progressive-content.ts";

export const PROGRESSIVE_CONTENT_REALIZATION_SCHEMA_VERSION =
  "elizaos.progressive-content.realization.v1" as const;
export const PROGRESSIVE_CONTENT_SOURCE_PAGE_BYTES = 64 * 1024;

export interface ProgressiveSourceWork {
  readonly readCalls: number;
  readonly bytesRead: number;
  readonly maxReadBytes: number;
}

export interface ProgressiveBoundedSource {
  readonly byteLength: number;
  read(offset: number, maxBytes?: number): Promise<Uint8Array>;
  work(): ProgressiveSourceWork;
}

export interface ProgressiveNativeRealization {
  readonly reference: {
    readonly kind:
      | Exclude<ProgressiveContentFamily, "tool-output">
      | "tool-result";
    readonly ref: string;
  };
  readonly revision: string;
  readonly authorizationScope: string;
  readonly cleanupIdentity: string;
  readonly resolverBindingSha256: string;
}

export type ProgressiveNativeRealizerDeclaration =
  | {
      readonly family: ProgressiveContentFamily;
      readonly adapterId: string;
      realize(input: {
        readonly object: ProgressiveContentObject;
        readonly source: ProgressiveBoundedSource;
      }): Promise<ProgressiveNativeRealization>;
    }
  | {
      readonly family: ProgressiveContentFamily;
      readonly adapterId: string;
      readonly status: "unsupported" | "pending";
      readonly code: string;
      readonly blocker: string;
    };

export interface ProgressiveNativeRealizationEntry {
  readonly objectId: string;
  readonly family: ProgressiveContentFamily;
  readonly adapterId: string;
  readonly status: "verified" | "unsupported" | "pending" | "failed";
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly sourceWork: ProgressiveSourceWork;
  readonly reference?: ProgressiveNativeRealization["reference"];
  readonly revision?: string;
  readonly authorizationScope?: string;
  readonly cleanupIdentity?: string;
  readonly resolverBindingSha256?: string;
  readonly code?: string;
  readonly blocker?: string;
}

export interface ProgressiveNativeRealizationLedger {
  readonly schemaVersion: typeof PROGRESSIVE_CONTENT_REALIZATION_SCHEMA_VERSION;
  readonly corpusSchemaVersion: ProgressiveContentManifest["schemaVersion"];
  readonly corpusManifestSha256: string;
  readonly generatorRevision: string;
  readonly entries: readonly ProgressiveNativeRealizationEntry[];
  readonly counts: Readonly<
    Record<ProgressiveNativeRealizationEntry["status"], number>
  >;
}

export class ProgressiveNativeRealizationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProgressiveNativeRealizationError";
  }
}

async function boundedSource(
  corpusRoot: string,
  object: ProgressiveContentObject,
): Promise<{
  source: ProgressiveBoundedSource;
  exactCoverage(): boolean;
  close(): Promise<void>;
}> {
  const parts = object.relativePath.split("/");
  if (
    path.posix.isAbsolute(object.relativePath) ||
    object.relativePath.includes("\\") ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new ProgressiveNativeRealizationError(
      "PROGRESSIVE_REALIZATION_SOURCE_PATH_INVALID",
      `unsafe source path for ${object.id}`,
    );
  }
  const handle = await open(
    path.join(corpusRoot, ...parts),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let readCalls = 0;
  let bytesRead = 0;
  let maxReadBytes = 0;
  const ranges: Array<readonly [number, number]> = [];
  return {
    source: {
      byteLength: object.byteLength,
      async read(offset, requested = PROGRESSIVE_CONTENT_SOURCE_PAGE_BYTES) {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(requested) ||
          requested <= 0 ||
          requested > PROGRESSIVE_CONTENT_SOURCE_PAGE_BYTES
        ) {
          throw new ProgressiveNativeRealizationError(
            "PROGRESSIVE_REALIZATION_READ_UNBOUNDED",
            `source reads require a nonnegative offset and 1..${PROGRESSIVE_CONTENT_SOURCE_PAGE_BYTES} bytes`,
          );
        }
        const length = Math.min(
          requested,
          Math.max(0, object.byteLength - offset),
        );
        const buffer = Buffer.allocUnsafe(length);
        const result = await handle.read(buffer, 0, length, offset);
        readCalls += 1;
        bytesRead += result.bytesRead;
        maxReadBytes = Math.max(maxReadBytes, result.bytesRead);
        if (result.bytesRead > 0)
          ranges.push([offset, offset + result.bytesRead]);
        return buffer.subarray(0, result.bytesRead);
      },
      work: () => ({ readCalls, bytesRead, maxReadBytes }),
    },
    exactCoverage: () => {
      if (object.byteLength === 0) return ranges.length === 0;
      let expected = 0;
      for (const [start, end] of [...ranges].sort(
        (left, right) => left[0] - right[0],
      )) {
        if (start !== expected || end <= start) return false;
        expected = end;
      }
      return expected === object.byteLength;
    },
    close: () => handle.close(),
  };
}

/** Consume a bounded source exactly once and return its source SHA-256. */
export async function consumeProgressiveSource(
  source: ProgressiveBoundedSource,
): Promise<string> {
  const digest = createHash("sha256");
  let offset = 0;
  while (offset < source.byteLength) {
    const bytes = await source.read(offset);
    if (bytes.byteLength === 0) {
      throw new ProgressiveNativeRealizationError(
        "PROGRESSIVE_REALIZATION_NO_PROGRESS",
        `source stopped at ${offset}`,
      );
    }
    digest.update(bytes);
    offset += bytes.byteLength;
  }
  return digest.digest("hex");
}

/** Execute each object against one declared native family boundary. */
export async function realizeProgressiveContentCorpus(input: {
  readonly corpusRoot: string;
  readonly manifest: ProgressiveContentManifest;
  readonly realizers: readonly ProgressiveNativeRealizerDeclaration[];
}): Promise<ProgressiveNativeRealizationLedger> {
  const declarations = new Map<
    ProgressiveContentFamily,
    ProgressiveNativeRealizerDeclaration
  >();
  for (const declaration of input.realizers) {
    if (declarations.has(declaration.family)) {
      throw new ProgressiveNativeRealizationError(
        "PROGRESSIVE_REALIZATION_DUPLICATE_ADAPTER",
        `multiple adapters declared for ${declaration.family}`,
      );
    }
    declarations.set(declaration.family, declaration);
  }
  const entries: ProgressiveNativeRealizationEntry[] = [];
  for (const object of input.manifest.objects) {
    const declaration = declarations.get(object.family);
    if (!declaration || "status" in declaration) {
      entries.push({
        objectId: object.id,
        family: object.family,
        adapterId: declaration?.adapterId ?? "undeclared",
        status: declaration?.status ?? "unsupported",
        sourceSha256: object.sourceSha256,
        sourceBytes: object.byteLength,
        sourceWork: { readCalls: 0, bytesRead: 0, maxReadBytes: 0 },
        code: declaration?.code ?? "PROGRESSIVE_NATIVE_ADAPTER_UNDECLARED",
        blocker:
          declaration?.blocker ??
          `no production native realizer is registered for ${object.family}`,
      });
      continue;
    }
    const opened = await boundedSource(input.corpusRoot, object);
    try {
      const realized = await declaration.realize({
        object,
        source: opened.source,
      });
      const expectedKind =
        object.family === "tool-output" ? "tool-result" : object.family;
      if (
        realized.reference.kind !== expectedKind ||
        !realized.reference.ref ||
        realized.revision !== object.revision ||
        realized.authorizationScope !== object.authorizationScope ||
        !realized.cleanupIdentity ||
        !/^[0-9a-f]{64}$/u.test(realized.resolverBindingSha256) ||
        !opened.exactCoverage()
      ) {
        throw new ProgressiveNativeRealizationError(
          "PROGRESSIVE_REALIZATION_RESULT_INVALID",
          `native realization is incomplete or mismatched for ${object.id}`,
        );
      }
      entries.push({
        objectId: object.id,
        family: object.family,
        adapterId: declaration.adapterId,
        status: "verified",
        sourceSha256: object.sourceSha256,
        sourceBytes: object.byteLength,
        sourceWork: opened.source.work(),
        ...realized,
      });
    } catch (error) {
      entries.push({
        objectId: object.id,
        family: object.family,
        adapterId: declaration.adapterId,
        status: "failed",
        sourceSha256: object.sourceSha256,
        sourceBytes: object.byteLength,
        sourceWork: opened.source.work(),
        code:
          error instanceof ProgressiveNativeRealizationError
            ? error.code
            : "PROGRESSIVE_REALIZATION_FAILED",
        blocker: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await opened.close();
    }
  }
  const counts = {
    verified: 0,
    unsupported: 0,
    pending: 0,
    failed: 0,
  };
  for (const entry of entries) counts[entry.status] += 1;
  return {
    schemaVersion: PROGRESSIVE_CONTENT_REALIZATION_SCHEMA_VERSION,
    corpusSchemaVersion: input.manifest.schemaVersion,
    corpusManifestSha256: input.manifest.manifestSha256,
    generatorRevision: input.manifest.generatorRevision,
    entries,
    counts,
  };
}
