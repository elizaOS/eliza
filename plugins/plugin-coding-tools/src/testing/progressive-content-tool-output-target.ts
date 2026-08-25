/**
 * Realizes corpus bytes as one immutable owner-scoped shell-output artifact and
 * exposes the artifact store's production byte reader through the shared target
 * lifecycle. The opaque handle remains restart-safe until its signed expiry.
 */

import { createHash } from "node:crypto";
import { buildReadView } from "@elizaos/core";
import {
  PROGRESSIVE_CONTENT_TARGET_FACTORY_SCHEMA_VERSION,
  type ProgressiveContentTarget,
  type ProgressiveContentTargetFactory,
} from "@elizaos/core/testing";
import {
  deleteShellOutputArtifact,
  persistShellOutputByteArtifact,
  readShellOutputArtifactBytePage,
  renewShellOutputArtifactLease,
} from "../lib/shell-output-artifact.js";

const SOURCE_PAGE_BYTES = 64 * 1024;

class ProgressiveToolOutputTargetError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProgressiveToolOutputTargetError";
  }
}

function resultErrorCode(
  reason: "invalid_handle" | "unavailable" | "expired" | "corrupt",
): string {
  if (reason === "expired") return "CONTENT_REFERENCE_EXPIRED";
  if (reason === "corrupt") return "CONTENT_REFERENCE_CORRUPT";
  return "CONTENT_NOT_FOUND";
}

/** Create the package-owned immutable shell-artifact target factory. */
export function createProgressiveToolOutputTargetFactory(input: {
  agentId: string;
}): ProgressiveContentTargetFactory {
  return {
    schemaVersion: PROGRESSIVE_CONTENT_TARGET_FACTORY_SCHEMA_VERSION,
    family: "tool-output",
    adapterId: "coding-tools-shell-output-artifact-production-v1",
    authoritativeStore: "filesystem",
    productionMethod:
      "shell-output-artifact.persistShellOutputByteArtifact/readShellOutputArtifactBytePage",
    binaryPolicy: "native-bytes",
    async create({ object, source }) {
      if (
        object.family !== "tool-output" ||
        source.byteLength !== object.byteLength
      ) {
        throw new TypeError(
          "tool-output target received a mismatched corpus object",
        );
      }
      const artifact = await persistShellOutputByteArtifact({
        chunks: (async function* () {
          for (let offset = 0; offset < source.byteLength; ) {
            const page = await source.read(offset, SOURCE_PAGE_BYTES);
            if (
              !(page instanceof Uint8Array) ||
              page.byteLength === 0 ||
              page.byteLength > SOURCE_PAGE_BYTES ||
              page.byteLength > source.byteLength - offset
            ) {
              throw new ProgressiveToolOutputTargetError(
                "PROGRESSIVE_REALIZATION_NO_PROGRESS",
              );
            }
            yield page;
            offset += page.byteLength;
          }
        })(),
        stream: "stdout",
        exitCode: 0,
        timedOut: false,
        signal: null,
        ownerAgentId: input.agentId,
        ownerConversationId: object.authorizationScope,
      });
      const expectedRevision = `sha256:${object.sourceSha256}`;
      if (
        artifact.byteLength !== object.byteLength ||
        artifact.contentRevision !== expectedRevision
      ) {
        await deleteShellOutputArtifact({
          handle: artifact.handle,
          requesterAgentId: input.agentId,
          requesterConversationId: object.authorizationScope,
        });
        throw new ProgressiveToolOutputTargetError(
          "PROGRESSIVE_REALIZATION_HASH_MISMATCH",
        );
      }

      let reference = {
        kind: "tool-result" as const,
        ref: `shell-artifact:${artifact.handle}:stdout`,
        revision: artifact.contentRevision,
        resumability: "restart-safe" as const,
        expiresAt: artifact.expiresAt,
      };
      let active = true;
      let generation = 1;
      const target: ProgressiveContentTarget = {
        family: "tool-output",
        object: {
          id: object.id,
          family: "tool-result",
          byteLength: object.byteLength,
          sourceSha256: object.sourceSha256,
          revision: artifact.contentRevision,
          authorizationScope: object.authorizationScope,
          canaries: object.canaries,
        },
        realization: {
          reference,
          sourceRevision: object.sourceRevision,
          authorizationMode: "principal",
          restartScope: "resolver",
          authorizationScopeDigest: createHash("sha256")
            .update(`${input.agentId}:${object.authorizationScope}`)
            .digest("hex"),
          cleanupIdentity: `shell-artifact:${artifact.handle}`,
          resolverBindingSha256: createHash("sha256")
            .update(
              `${artifact.handle}:${artifact.contentRevision}:${input.agentId}:${object.authorizationScope}`,
            )
            .digest("hex"),
        },
        async read({ access, offset, limit, expectedRevision: asserted }) {
          if (!active) {
            throw new ProgressiveToolOutputTargetError("CONTENT_NOT_FOUND");
          }
          if (asserted && asserted !== artifact.contentRevision) {
            throw new ProgressiveToolOutputTargetError(
              "CONTENT_STALE_REVISION",
            );
          }
          const requesterConversationId =
            access === "authorized"
              ? object.authorizationScope
              : `${object.authorizationScope}:${access}`;
          const result = await readShellOutputArtifactBytePage({
            handle: artifact.handle,
            stream: "stdout",
            offset,
            limit,
            requesterAgentId: input.agentId,
            requesterConversationId,
          });
          if (!result.ok) {
            throw new ProgressiveToolOutputTargetError(
              access === "unauthorized"
                ? "CONTENT_ACCESS_DENIED"
                : resultErrorCode(result.reason),
            );
          }
          const page = result.value;
          return {
            bytes: page.bytes,
            view: buildReadView({
              reference,
              slice: {
                range: {
                  unit: "byte",
                  start: page.startOffset,
                  end: page.endOffset,
                  total: page.totalBytes,
                },
                hasPrevious: page.startOffset > 0,
                hasMore: !page.complete,
                ...(!page.complete ? { nextOffset: page.nextOffset } : {}),
                revision: artifact.contentRevision,
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
              bytesRead: page.sourceBytesRead,
              rowsRead: page.sourceSegmentsRead,
              parentScans: 0,
            },
          };
        },
        async restart() {
          if (!active) {
            throw new ProgressiveToolOutputTargetError("CONTENT_NOT_FOUND");
          }
          const renewed = await renewShellOutputArtifactLease({
            handle: artifact.handle,
            requesterAgentId: input.agentId,
            requesterConversationId: object.authorizationScope,
          });
          if (!renewed.ok) {
            throw new ProgressiveToolOutputTargetError(
              renewed.reason === "expired"
                ? "CONTENT_REFERENCE_EXPIRED"
                : "CONTENT_NOT_FOUND",
            );
          }
          reference = { ...reference, expiresAt: renewed.value.expiresAt };
          generation += 1;
        },
        async inspect() {
          const result = active
            ? await readShellOutputArtifactBytePage({
                handle: artifact.handle,
                stream: "stdout",
                offset: 0,
                limit: 1,
                requesterAgentId: input.agentId,
                requesterConversationId: object.authorizationScope,
              })
            : undefined;
          return {
            resolverGeneration: `shell-artifact:${generation}`,
            present: result?.ok === true,
            ownedBytes: result?.ok ? result.value.totalBytes : 0,
            databaseRows: 0,
            temporaryArtifacts: 0,
            walBytes: 0,
          };
        },
        async cleanup() {
          if (!active) return;
          const deleted = await deleteShellOutputArtifact({
            handle: artifact.handle,
            requesterAgentId: input.agentId,
            requesterConversationId: object.authorizationScope,
          });
          active = false;
          if (!deleted) {
            throw new ProgressiveToolOutputTargetError(
              "CONTENT_CLEANUP_FAILED",
            );
          }
        },
      };
      return target;
    },
  };
}
