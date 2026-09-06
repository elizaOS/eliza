/** Exercises binary tool-output paging through the real immutable artifact store. */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProgressiveContentTargetConformance } from "@elizaos/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createProgressiveToolOutputTargetFactory } from "./progressive-content-tool-output-target.js";

const roots: string[] = [];
const priorStateDir = process.env.ELIZA_STATE_DIR;

afterEach(async () => {
  if (priorStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = priorStateDir;
  for (const root of roots.splice(0).reverse()) {
    await rm(root, { recursive: true });
  }
});

describe("progressive tool-output target", () => {
  it("preserves arbitrary bytes across artifact pages and resolver restart", async () => {
    const stateDir = await mkdtemp(
      path.join(tmpdir(), "progressive-tool-output-target-"),
    );
    roots.push(stateDir);
    process.env.ELIZA_STATE_DIR = stateDir;
    const bytes = Buffer.alloc(160 * 1024 + 19);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (index * 193 + 0xff) & 0xff;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const factory = createProgressiveToolOutputTargetFactory({
      agentId: "progressive-tool-output-agent",
    });
    const target = await factory.create({
      object: {
        id: "tool-output-binary",
        family: "tool-output",
        byteLength: bytes.byteLength,
        sourceSha256: digest,
        sourceRevision: digest,
        format: "binary",
        authorizationScope: "room:tool-owner",
        canaries: [],
      },
      source: {
        byteLength: bytes.byteLength,
        async read(offset, maxBytes = 64 * 1024) {
          return bytes.subarray(offset, offset + maxBytes);
        },
      },
    });
    expect(target.realization.authorizationMode).toBe("principal");
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
