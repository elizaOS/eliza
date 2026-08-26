/**
 * Realizes corpus attachment bytes through the canonical content-addressed
 * media store and exposes its bounded byte reader through the shared target
 * lifecycle. The served media URL is the capability; no principal identity is
 * invented for the pre-authenticated media boundary.
 */

import { createHash } from "node:crypto";
import { buildReadView } from "@elizaos/core";
import {
  PROGRESSIVE_CONTENT_TARGET_FACTORY_SCHEMA_VERSION,
  type ProgressiveContentTarget,
  type ProgressiveContentTargetFactory,
} from "@elizaos/core/testing";
import {
  deleteMediaFile,
  mediaFileNameFromUrl,
  persistMediaStream,
  readStoredMediaByteRange,
} from "../api/media-store.ts";

const SOURCE_PAGE_BYTES = 64 * 1024;

class ProgressiveAttachmentTargetError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProgressiveAttachmentTargetError";
  }
}

/** Create the canonical-media attachment target used by conformance lanes. */
export function createProgressiveAttachmentTargetFactory(): ProgressiveContentTargetFactory {
  return {
    schemaVersion: PROGRESSIVE_CONTENT_TARGET_FACTORY_SCHEMA_VERSION,
    family: "attachment",
    adapterId: "agent-content-addressed-media-production-v1",
    authoritativeStore: "content-addressed-media",
    productionMethod: "media-store.persistMediaStream/readStoredMediaByteRange",
    binaryPolicy: "native-bytes",
    async create({ object, source }) {
      if (
        object.family !== "attachment" ||
        source.byteLength !== object.byteLength
      ) {
        throw new TypeError(
          "attachment target received a mismatched corpus object",
        );
      }
      const expectedFileName = `${object.sourceSha256}.bin`;
      const existedBefore =
        readStoredMediaByteRange(expectedFileName, 0, 1) !== null;
      const persisted = await persistMediaStream(
        (async function* () {
          for (let offset = 0; offset < source.byteLength; ) {
            const page = await source.read(offset, SOURCE_PAGE_BYTES);
            if (
              !(page instanceof Uint8Array) ||
              page.byteLength === 0 ||
              page.byteLength > SOURCE_PAGE_BYTES ||
              page.byteLength > source.byteLength - offset
            ) {
              throw new ProgressiveAttachmentTargetError(
                "PROGRESSIVE_REALIZATION_NO_PROGRESS",
              );
            }
            yield page;
            offset += page.byteLength;
          }
        })(),
        "application/octet-stream",
      );
      if (persisted.hash !== object.sourceSha256) {
        if (!existedBefore) deleteMediaFile(persisted.fileName);
        throw new ProgressiveAttachmentTargetError(
          "PROGRESSIVE_REALIZATION_HASH_MISMATCH",
        );
      }
      const fileName = mediaFileNameFromUrl(persisted.url);
      if (!fileName) {
        if (!existedBefore) deleteMediaFile(persisted.fileName);
        throw new ProgressiveAttachmentTargetError(
          "PROGRESSIVE_REALIZATION_REFERENCE_INVALID",
        );
      }

      const revision = `sha256:${persisted.hash}`;
      const reference = {
        kind: "attachment" as const,
        ref: `media_${persisted.hash}`,
        revision,
        resumability: "restart-safe" as const,
      };
      let generation = 1;
      let active = true;
      const target: ProgressiveContentTarget = {
        family: "attachment",
        object: {
          id: object.id,
          family: "attachment",
          byteLength: object.byteLength,
          sourceSha256: object.sourceSha256,
          revision,
          authorizationScope: object.authorizationScope,
          canaries: object.canaries,
        },
        realization: {
          reference,
          sourceRevision: object.sourceRevision,
          authorizationMode: "capability",
          restartScope: "resolver",
          authorizationScopeDigest: createHash("sha256")
            .update(persisted.url)
            .digest("hex"),
          cleanupIdentity: `media:${fileName}`,
          resolverBindingSha256: createHash("sha256")
            .update(`${persisted.url}:${revision}`)
            .digest("hex"),
        },
        async read({ access, offset, limit, expectedRevision }) {
          if (!active || access === "isolated") {
            throw new ProgressiveAttachmentTargetError("CONTENT_NOT_FOUND");
          }
          if (access === "unauthorized") {
            throw new ProgressiveAttachmentTargetError("CONTENT_ACCESS_DENIED");
          }
          if (expectedRevision && expectedRevision !== revision) {
            throw new ProgressiveAttachmentTargetError(
              "CONTENT_STALE_REVISION",
            );
          }
          const page = readStoredMediaByteRange(fileName, offset, limit);
          if (!page) {
            throw new ProgressiveAttachmentTargetError("CONTENT_NOT_FOUND");
          }
          return {
            bytes: page.bytes,
            view: buildReadView({
              reference,
              slice: {
                range: {
                  unit: "byte",
                  start: page.start,
                  end: page.end,
                  total: page.total,
                },
                hasPrevious: page.start > 0,
                hasMore: !page.complete,
                ...(!page.complete ? { nextOffset: page.end } : {}),
                revision,
                completeness: page.complete
                  ? "complete"
                  : "partial-recoverable",
                sliceSha256: createHash("sha256")
                  .update(page.bytes)
                  .digest("hex"),
              },
            }),
            sourceWork: {
              readCalls: 1,
              bytesRead: page.bytes.byteLength,
              rowsRead: 1,
              parentScans: 0,
            },
          };
        },
        async restart() {
          if (!active) {
            throw new ProgressiveAttachmentTargetError("CONTENT_NOT_FOUND");
          }
          generation += 1;
        },
        async inspect() {
          const page = active ? readStoredMediaByteRange(fileName, 0, 1) : null;
          return {
            resolverGeneration: `media:${generation}`,
            present: page !== null,
            ownedBytes: existedBefore ? 0 : (page?.total ?? 0),
            databaseRows: 0,
            temporaryArtifacts: 0,
            walBytes: 0,
          };
        },
        async cleanup() {
          active = false;
          if (!existedBefore) deleteMediaFile(fileName);
        },
      };
      return target;
    },
  };
}
