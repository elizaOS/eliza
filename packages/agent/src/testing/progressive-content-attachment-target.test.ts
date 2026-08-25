/** Exercises the real canonical media store through the shared target lifecycle. */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProgressiveContentTargetConformance } from "@elizaos/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createProgressiveAttachmentTargetFactory } from "./progressive-content-attachment-target.ts";

const roots: string[] = [];
const priorStateDir = process.env.ELIZA_STATE_DIR;

afterEach(async () => {
  if (priorStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = priorStateDir;
  for (const root of roots.splice(0).reverse()) {
    await rm(root, { recursive: true });
  }
});

describe("progressive attachment target", () => {
  it("streams binary bytes into canonical media and proves restart/auth/cleanup", async () => {
    const stateDir = await mkdtemp(
      path.join(tmpdir(), "progressive-attachment-target-"),
    );
    roots.push(stateDir);
    process.env.ELIZA_STATE_DIR = stateDir;
    const bytes = Buffer.alloc(192 * 1024 + 37);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (index * 131 + 17) & 0xff;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const factory = createProgressiveAttachmentTargetFactory();
    const target = await factory.create({
      object: {
        id: "attachment-binary",
        family: "attachment",
        byteLength: bytes.byteLength,
        sourceSha256: digest,
        sourceRevision: digest,
        format: "binary",
        authorizationScope: "room:attachment-owner",
        canaries: [],
      },
      source: {
        byteLength: bytes.byteLength,
        async read(offset, maxBytes = 64 * 1024) {
          return bytes.subarray(offset, offset + maxBytes);
        },
      },
    });
    expect(target.realization.authorizationMode).toBe("capability");
    expect(target.realization.restartScope).toBe("resolver");
    const result = await runProgressiveContentTargetConformance({
      manifestSha256: digest,
      adapterId: factory.adapterId,
      target,
    });
    expect(result.report.failures).toEqual([]);
    expect(result.report.status).toBe("passed");
    expect(result.receipts.every(({ status }) => status === "passed")).toBe(
      true,
    );
  });
});
