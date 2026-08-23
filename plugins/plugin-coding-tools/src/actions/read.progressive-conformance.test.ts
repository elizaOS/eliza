/** Runs shared Unicode paging, authorization, restart, cleanup, and work vectors through the production FILE handler. */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ReadView } from "@elizaos/core";
import {
  PROGRESSIVE_CONTENT_DELIVERY_CONTRACT,
  type ProgressiveContentConformanceAdapter,
  runProgressiveContentConformance,
} from "@elizaos/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupEnv, type TestEnv } from "./_test-helpers.js";
import { readFileHandler } from "./read.js";

class FileConformanceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

describe("READ progressive-content conformance", () => {
  const environments: TestEnv[] = [];

  afterEach(async () => {
    for (const environment of environments.splice(0).reverse()) {
      await environment.cleanup();
    }
  });

  it("uses the production handler for Unicode pages, denial, restart, and post-cleanup failure", async () => {
    let env = await setupEnv("read-progressive-conformance");
    environments.push(env);
    const file = path.join(env.tmpDir, "corpus-file.txt");
    const blockedFile = path.join(env.blockedPath, "denied.txt");
    const pattern = Buffer.from("世界🙂ABCDEF", "utf8");
    const bytes = Buffer.allocUnsafe(1024 * 1024);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = pattern[index % pattern.length] ?? 0x41;
    }
    const canaries = [
      { label: "beginning", text: "B世界🙂ABCDE", byteStart: 0 },
      { label: "boundary", text: "D世界🙂ABCDE", byteStart: 65_536 },
      { label: "middle", text: "M世界🙂ABCDE", byteStart: 512 * 1024 },
      { label: "end", text: "E世界🙂ABCDE", byteStart: bytes.length - 16 },
    ].map((canary) => ({ ...canary, byteEnd: canary.byteStart + 16 }));
    for (const canary of canaries) bytes.write(canary.text, canary.byteStart);
    await Promise.all([
      fs.writeFile(file, bytes),
      fs.writeFile(blockedFile, "denied"),
    ]);
    const object = {
      id: "coding-file-corpus-object",
      family: "file" as const,
      byteLength: bytes.length,
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      revision: "",
      authorizationScope: String(env.message.roomId),
      canaries,
    };
    const first = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, unit: "byte", offset: 0, limit: 1 },
    });
    object.revision = (first.data as { readView: ReadView }).readView.slice
      .revision as string;

    let productionHandlerCalls = 1;
    let productionDenials = 0;
    const adapter: ProgressiveContentConformanceAdapter = {
      adapterId: "coding-tools-file-production-v2",
      deliveryContract: PROGRESSIVE_CONTENT_DELIVERY_CONTRACT,
      async read(request) {
        const unauthorized =
          request.authorizationScope !== object.authorizationScope;
        productionHandlerCalls += 1;
        const result = await readFileHandler(
          env.runtime,
          env.message,
          undefined,
          {
            parameters: {
              file_path: unauthorized ? blockedFile : file,
              unit: "byte",
              offset: request.offset,
              limit: request.limit,
              ...(request.expectedRevision
                ? { expectedRevision: request.expectedRevision }
                : {}),
            },
          },
        );
        if (!result.success) {
          if (result.text?.includes("path_blocked")) {
            productionDenials += 1;
            throw new FileConformanceError("CONTENT_ACCESS_DENIED");
          }
          if (result.text?.includes("stale_read")) {
            throw new FileConformanceError("CONTENT_STALE_REVISION");
          }
          if (result.text?.includes("ENOENT")) {
            throw new FileConformanceError("FILE_NOT_FOUND");
          }
          throw new FileConformanceError("FILE_READ_FAILED");
        }
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
        await env.sandbox.stop();
        await env.fileState.stop();
        await env.sessionCwd.stop();
        env = await setupEnv("read-progressive-conformance-restart", {
          rootsPath: path.dirname(file),
          blockedPath: path.dirname(blockedFile),
        });
        environments.push(env);
      },
      async cleanup() {
        await fs.unlink(file);
      },
      async measureResources() {
        try {
          return { databaseBytes: (await fs.stat(file)).size };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { databaseBytes: 0 };
          }
          throw error;
        }
      },
    };
    const report = await runProgressiveContentConformance({
      adapter,
      object,
      performanceCeilings: {
        maxRowsPerPage: 1,
        maxReadAmplification: 1.1,
        maxRssGrowthBytes: 192 * 1024 * 1024,
      },
    });
    expect(report).toMatchObject({
      status: "passed",
      restartVerified: true,
      concurrencyVerified: true,
      repeatedPageVerified: true,
      cleanupVerified: true,
      postCleanupProbeVerified: true,
      reassembledSha256: object.sourceSha256,
    });
    expect(productionHandlerCalls).toBeGreaterThan(report.pages);
    expect(productionDenials).toBe(1);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
