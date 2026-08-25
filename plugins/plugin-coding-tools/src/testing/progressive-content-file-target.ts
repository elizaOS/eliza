/**
 * Realizes bounded corpus bytes into a private workspace file and exposes the
 * production READ action through the shared progressive-content target
 * lifecycle. The target owns its realization; cleanup never deletes the oracle
 * corpus source.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IAgentRuntime, Memory, ReadView, Service } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import {
  PROGRESSIVE_CONTENT_TARGET_FACTORY_SCHEMA_VERSION,
  type ProgressiveContentTarget,
  type ProgressiveContentTargetFactory,
} from "@elizaos/core/testing";
import { readFileHandler } from "../actions/read.js";
import { FileStateService } from "../services/file-state-service.js";
import { SandboxService } from "../services/sandbox-service.js";
import { SessionCwdService } from "../services/session-cwd-service.js";
import {
  FILE_STATE_SERVICE,
  SANDBOX_SERVICE,
  SESSION_CWD_SERVICE,
} from "../types.js";

const SOURCE_PAGE_BYTES = 64 * 1024;

class ProgressiveFileTargetError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "ProgressiveFileTargetError";
  }
}

interface FileResolver {
  runtime: IAgentRuntime;
  message: Memory;
  sandbox: SandboxService;
  fileState: FileStateService;
  sessionCwd: SessionCwdService;
}

async function startResolver(input: {
  targetRoot: string;
  blockedRoot: string;
  agentId: string;
  conversationId: string;
}): Promise<FileResolver> {
  const settings: Record<string, string> = {
    CODING_TOOLS_WORKSPACE_ROOTS: input.targetRoot,
    CODING_TOOLS_BLOCKED_PATHS: input.blockedRoot,
    CODING_TOOLS_MAX_FILE_SIZE_BYTES: String(SOURCE_PAGE_BYTES),
  };
  const services = new Map<string, Service>();
  const runtime = {
    agentId: stringToUuid(input.agentId),
    getSetting: (key: string) => settings[key],
    getService: (key: string) => services.get(key) ?? null,
  } as IAgentRuntime;
  const sandbox = await SandboxService.start(runtime);
  const fileState = await FileStateService.start(runtime);
  const sessionCwd = await SessionCwdService.start(runtime);
  services.set(SANDBOX_SERVICE, sandbox);
  services.set(FILE_STATE_SERVICE, fileState);
  services.set(SESSION_CWD_SERVICE, sessionCwd);
  return {
    runtime,
    sandbox,
    fileState,
    sessionCwd,
    message: {
      agentId: runtime.agentId,
      roomId: stringToUuid(input.conversationId),
      entityId: stringToUuid(`${input.conversationId}:entity`),
      content: {},
    },
  };
}

async function stopResolver(resolver: FileResolver): Promise<void> {
  await resolver.sessionCwd.stop();
  await resolver.fileState.stop();
  await resolver.sandbox.stop();
}

function readError(result: { text?: string }): ProgressiveFileTargetError {
  const text = result.text ?? "";
  if (text.includes("stale_read"))
    return new ProgressiveFileTargetError("CONTENT_STALE_REVISION");
  if (text.includes("ENOENT"))
    return new ProgressiveFileTargetError("FILE_NOT_FOUND");
  if (text.includes("invalid UTF-8"))
    return new ProgressiveFileTargetError("CONTENT_INVALID_UTF8");
  return new ProgressiveFileTargetError("FILE_READ_FAILED", text);
}

/** Create the package-owned FILE factory used by corpus, conformance, and soak lanes. */
export async function createProgressiveFileTargetFactory(input: {
  targetRoot: string;
  agentId: string;
}): Promise<ProgressiveContentTargetFactory> {
  await fs.mkdir(input.targetRoot, { recursive: true, mode: 0o700 });
  const targetRoot = await fs.realpath(input.targetRoot);
  const blockedRoot = path.join(targetRoot, ".blocked");
  await fs.mkdir(blockedRoot, { mode: 0o700 });
  return {
    schemaVersion: PROGRESSIVE_CONTENT_TARGET_FACTORY_SCHEMA_VERSION,
    family: "file",
    adapterId: "coding-tools-file-production-v3",
    authoritativeStore: "filesystem",
    productionMethod: "READ.byteWindow",
    binaryPolicy: "typed-rejection",
    async create({ object, source }) {
      if (object.family !== "file" || source.byteLength !== object.byteLength) {
        throw new TypeError("FILE target received a mismatched corpus object");
      }
      if (object.format === "binary") {
        throw new ProgressiveFileTargetError("CONTENT_BINARY_UNSUPPORTED");
      }
      const targetName = `${createHash("sha256").update(object.id).digest("hex")}.txt`;
      const targetPath = path.join(targetRoot, targetName);
      const handle = await fs.open(targetPath, "wx", 0o600);
      const digest = createHash("sha256");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let offset = 0;
      try {
        try {
          while (offset < source.byteLength) {
            const page = await source.read(offset, SOURCE_PAGE_BYTES);
            if (
              !(page instanceof Uint8Array) ||
              page.byteLength === 0 ||
              page.byteLength > SOURCE_PAGE_BYTES ||
              page.byteLength > source.byteLength - offset
            ) {
              throw new ProgressiveFileTargetError(
                "PROGRESSIVE_REALIZATION_NO_PROGRESS",
              );
            }
            try {
              decoder.decode(page, { stream: true });
            } catch {
              throw new ProgressiveFileTargetError("CONTENT_INVALID_UTF8");
            }
            let pageOffset = 0;
            while (pageOffset < page.byteLength) {
              const written = await handle.write(
                page,
                pageOffset,
                page.byteLength - pageOffset,
                offset + pageOffset,
              );
              if (written.bytesWritten === 0) {
                throw new ProgressiveFileTargetError(
                  "PROGRESSIVE_REALIZATION_NO_PROGRESS",
                );
              }
              pageOffset += written.bytesWritten;
            }
            digest.update(page);
            offset += page.byteLength;
          }
          try {
            decoder.decode();
          } catch {
            throw new ProgressiveFileTargetError("CONTENT_INVALID_UTF8");
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        // error-policy:J6 failed realization removes only its private target.
        await fs
          .unlink(targetPath)
          .catch((cleanupError: NodeJS.ErrnoException) => {
            // error-policy:J6 absence is already-clean realization state.
            if (cleanupError.code !== "ENOENT") throw cleanupError;
          });
        throw error;
      }
      if (digest.digest("hex") !== object.sourceSha256) {
        await fs.unlink(targetPath);
        throw new ProgressiveFileTargetError(
          "PROGRESSIVE_REALIZATION_HASH_MISMATCH",
        );
      }

      let generation = 1;
      let resolver = await startResolver({
        targetRoot,
        blockedRoot,
        agentId: input.agentId,
        conversationId: object.authorizationScope,
      });
      let active = true;
      const initial = await readFileHandler(
        resolver.runtime,
        resolver.message,
        undefined,
        {
          parameters: {
            file_path: targetPath,
            unit: "byte",
            offset: 0,
            limit: 1,
          },
        },
      );
      if (!initial.success) {
        await stopResolver(resolver);
        await fs.unlink(targetPath);
        throw readError(initial);
      }
      const initialView = (initial.data as { readView: ReadView }).readView;
      const nativeRevision = initialView.reference.revision;
      if (!nativeRevision) {
        await stopResolver(resolver);
        await fs.unlink(targetPath);
        throw new Error("READ omitted its native revision");
      }
      const realization = {
        reference: initialView.reference,
        sourceRevision: object.sourceRevision,
        authorizationMode: "capability" as const,
        restartScope: "resolver" as const,
        authorizationScopeDigest: createHash("sha256")
          .update(object.authorizationScope)
          .digest("hex"),
        cleanupIdentity: `file:${createHash("sha256").update(targetName).digest("hex")}`,
        resolverBindingSha256: createHash("sha256")
          .update(`${object.sourceSha256}:${nativeRevision}:${targetName}`)
          .digest("hex"),
      };
      const target: ProgressiveContentTarget = {
        family: "file",
        object: {
          id: object.id,
          family: "file",
          byteLength: object.byteLength,
          sourceSha256: object.sourceSha256,
          revision: nativeRevision,
          authorizationScope: object.authorizationScope,
          canaries: object.canaries,
        },
        realization,
        async read({ access, offset: readOffset, limit, expectedRevision }) {
          if (!active) throw new ProgressiveFileTargetError("FILE_NOT_FOUND");
          if (access !== "authorized") {
            throw new ProgressiveFileTargetError(
              access === "isolated"
                ? "CONTENT_NOT_FOUND"
                : "CONTENT_ACCESS_DENIED",
            );
          }
          const result = await readFileHandler(
            resolver.runtime,
            resolver.message,
            undefined,
            {
              parameters: {
                file_path: targetPath,
                unit: "byte",
                offset: readOffset,
                limit,
                ...(expectedRevision ? { expectedRevision } : {}),
              },
            },
          );
          if (!result.success) throw readError(result);
          const data = result.data as {
            readView: ReadView;
            diagnostics: { sourceBytesRead: number };
          };
          return {
            bytes: Buffer.from(result.text ?? "", "utf8"),
            view: data.readView,
            sourceWork: {
              readCalls: 1,
              bytesRead: data.diagnostics.sourceBytesRead,
              rowsRead: 1,
              parentScans: 0,
            },
          };
        },
        async restart() {
          if (!active) throw new ProgressiveFileTargetError("FILE_NOT_FOUND");
          await stopResolver(resolver);
          resolver = await startResolver({
            targetRoot,
            blockedRoot,
            agentId: input.agentId,
            conversationId: object.authorizationScope,
          });
          generation += 1;
        },
        async inspect() {
          let ownedBytes = 0;
          try {
            const stat = await fs.lstat(targetPath);
            if (!stat.isFile() || stat.isSymbolicLink()) {
              throw new ProgressiveFileTargetError("FILE_TARGET_CORRUPT");
            }
            ownedBytes = stat.size;
          } catch (error) {
            // error-policy:J3 lstat absence is an explicit non-present snapshot.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          return {
            resolverGeneration: `file:${generation}`,
            present: ownedBytes > 0 || (active && object.byteLength === 0),
            ownedBytes,
            databaseRows: 0,
            temporaryArtifacts: 0,
            walBytes: 0,
          };
        },
        async cleanup() {
          if (active) {
            await stopResolver(resolver);
            active = false;
          }
          try {
            await fs.unlink(targetPath);
          } catch (error) {
            // error-policy:J6 target cleanup is idempotent only for absence.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
      return target;
    },
  };
}
