/** Exercises bounded scale realization and explicit unsupported-path evidence. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateProgressiveContentCorpus } from "./progressive-content.ts";
import {
  consumeProgressiveSource,
  PROGRESSIVE_CONTENT_SOURCE_PAGE_BYTES,
  type ProgressiveNativeRealizerDeclaration,
  realizeProgressiveContentCorpus,
} from "./progressive-content-realization.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const value of roots.splice(0)) await rm(value, { recursive: true });
});

describe("progressive native realization", () => {
  it("streams 1 and 10 MiB FILE objects and preserves exact blockers for both scales elsewhere", async () => {
    const corpusRoot = await mkdtemp(
      path.join(tmpdir(), "progressive-realization-"),
    );
    roots.push(corpusRoot);
    const manifest = await generateProgressiveContentCorpus({
      outDir: corpusRoot,
      rootSeed: "native-realization",
      generatorRevision: "test-revision",
      profile: "scale",
    });
    const pending = (
      family: "document" | "memory" | "email" | "attachment" | "tool-output",
      code: string,
    ): ProgressiveNativeRealizerDeclaration => ({
      family,
      adapterId: `${family}-production-v1`,
      status: "pending",
      code,
      blocker: `${family} production ingestion is not wired on current develop`,
    });
    const ledger = await realizeProgressiveContentCorpus({
      corpusRoot,
      manifest,
      realizers: [
        {
          family: "file",
          adapterId: "coding-file-native-v1",
          async realize({ object, source }) {
            expect(await consumeProgressiveSource(source)).toBe(
              object.sourceSha256,
            );
            return {
              reference: { kind: "file", ref: `file:${object.id}` },
              revision: object.revision,
              authorizationScope: object.authorizationScope,
              cleanupIdentity: `corpus:${object.id}`,
              resolverBindingSha256: object.sourceSha256,
            };
          },
        },
        pending("document", "DOCUMENT_SEGMENT_INGESTION_PENDING"),
        pending("memory", "MESSAGE_SEGMENT_INGESTION_PENDING"),
        pending("email", "GMAIL_DURABLE_BODY_INGESTION_PENDING"),
        pending("attachment", "ATTACHMENT_OWNER_BOUND_INGESTION_PENDING"),
        pending("tool-output", "PRIVATE_TOOL_ARTIFACT_LIFECYCLE_PENDING"),
      ],
    });
    expect(ledger.counts).toEqual({
      verified: 2,
      unsupported: 0,
      pending: 10,
      failed: 0,
    });
    for (const entry of ledger.entries.filter(
      ({ status }) => status === "verified",
    )) {
      expect(entry.sourceWork.bytesRead).toBe(entry.sourceBytes);
      expect(entry.sourceWork.maxReadBytes).toBeLessThanOrEqual(
        PROGRESSIVE_CONTENT_SOURCE_PAGE_BYTES,
      );
    }
    expect(
      new Set(
        ledger.entries
          .filter(({ status }) => status === "pending")
          .map(({ code }) => code),
      ),
    ).toEqual(
      new Set([
        "DOCUMENT_SEGMENT_INGESTION_PENDING",
        "MESSAGE_SEGMENT_INGESTION_PENDING",
        "GMAIL_DURABLE_BODY_INGESTION_PENDING",
        "ATTACHMENT_OWNER_BOUND_INGESTION_PENDING",
        "PRIVATE_TOOL_ARTIFACT_LIFECYCLE_PENDING",
      ]),
    );
  }, 60_000);

  it("records an oversized source read as failed evidence", async () => {
    const corpusRoot = await mkdtemp(
      path.join(tmpdir(), "progressive-realization-"),
    );
    roots.push(corpusRoot);
    const manifest = await generateProgressiveContentCorpus({
      outDir: corpusRoot,
      rootSeed: "unbounded-realization",
      generatorRevision: "test-revision",
      profile: "micro",
    });
    const ledger = await realizeProgressiveContentCorpus({
      corpusRoot,
      manifest,
      realizers: [
        {
          family: "file",
          adapterId: "unbounded-mutant",
          async realize({ source }) {
            await source.read(0, PROGRESSIVE_CONTENT_SOURCE_PAGE_BYTES + 1);
            throw new Error("unreachable");
          },
        },
      ],
    });
    expect(
      ledger.entries.find(({ family }) => family === "file"),
    ).toMatchObject({
      status: "failed",
      code: "PROGRESSIVE_REALIZATION_READ_UNBOUNDED",
    });
  });
});
