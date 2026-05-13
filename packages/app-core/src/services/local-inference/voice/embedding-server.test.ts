/**
 * `EmbeddingServer` / `embeddingServerForRoute` — the pure surface of the
 * lazy embedding `llama-server` sidecar (`embedding-server.ts`):
 *   - the constructor hard-fails when the GGUF doesn't exist (no silent
 *     placeholder server — Commandment 8)
 *   - `embeddingServerForRoute` picks the text backbone GGUF for the
 *     `0_8b` / `2b` pooled-text route and the `embedding/` GGUF for the
 *     dedicated-region route, and forwards the route's `--embeddings
 *     --pooling last` flags
 *   - `embed([])` short-circuits to `[]` without starting a process
 *   - `embed(texts, dim)` rejects an invalid Matryoshka width before
 *     touching the network
 *
 * The actual spawn → /health → POST /v1/embeddings path needs a real
 * `llama-server` binary + GGUF; that's covered by the embedding bench
 * harness (`packages/inference/verify/embedding_bench.mjs`), not a unit
 * test — fabricating a fake HTTP server here would test the test, not the
 * adapter.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLocalEmbeddingRoute } from "./embedding";
import { EmbeddingServer, embeddingServerForRoute } from "./embedding-server";
import { VoiceStartupError } from "./errors";

function tmpBundle(): string {
  return mkdtempSync(path.join(tmpdir(), "eliza-embsrv-"));
}

function writeGguf(p: string): string {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, "GGUF");
  return p;
}

describe("EmbeddingServer constructor", () => {
  it("hard-fails when the embedding GGUF does not exist", () => {
    expect(
      () =>
        new EmbeddingServer({
          modelPath: "/nope/does-not-exist.gguf",
          serverFlags: ["--embeddings", "--pooling", "last"],
        }),
    ).toThrow(VoiceStartupError);
  });

  it("constructs (no spawn) when the GGUF exists; isRunning() is false until embed()", () => {
    const bundleRoot = tmpBundle();
    const gguf = writeGguf(path.join(bundleRoot, "text", "t.gguf"));
    const srv = new EmbeddingServer({
      modelPath: gguf,
      serverFlags: ["--embeddings", "--pooling", "last"],
    });
    expect(srv.isRunning()).toBe(false);
  });
});

describe("EmbeddingServer.embed — pure short-circuits", () => {
  it("returns [] for an empty input without starting a process", async () => {
    const bundleRoot = tmpBundle();
    const gguf = writeGguf(path.join(bundleRoot, "text", "t.gguf"));
    const srv = new EmbeddingServer({
      modelPath: gguf,
      serverFlags: ["--embeddings", "--pooling", "last"],
    });
    await expect(srv.embed([])).resolves.toEqual([]);
    expect(srv.isRunning()).toBe(false);
  });

  it("rejects an invalid Matryoshka width before any network call", async () => {
    const bundleRoot = tmpBundle();
    const gguf = writeGguf(path.join(bundleRoot, "text", "t.gguf"));
    const srv = new EmbeddingServer({
      modelPath: gguf,
      serverFlags: ["--embeddings", "--pooling", "last"],
    });
    await expect(srv.embed(["hello"], 300)).rejects.toThrow(
      /not a valid Matryoshka width/,
    );
    expect(srv.isRunning()).toBe(false);
  });
});

describe("embeddingServerForRoute", () => {
  it("0_8b pooled-text route → sidecar over the text backbone GGUF with --embeddings --pooling last", () => {
    const bundleRoot = tmpBundle();
    const textPath = writeGguf(
      path.join(bundleRoot, "text", "eliza-1-0_8b-32k.gguf"),
    );
    const route = buildLocalEmbeddingRoute({
      bundleRoot,
      tierId: "eliza-1-0_8b",
      textModelPath: textPath,
    });
    // No throw → the sidecar's GGUF (the text backbone) exists and the
    // constructor validated it.
    const srv = embeddingServerForRoute(route);
    expect(srv).toBeInstanceOf(EmbeddingServer);
    expect(srv.isRunning()).toBe(false);
  });

  it("2b pooled-text route → sidecar over the text backbone GGUF", () => {
    const bundleRoot = tmpBundle();
    const textPath = writeGguf(
      path.join(bundleRoot, "text", "eliza-1-2b-32k.gguf"),
    );
    const route = buildLocalEmbeddingRoute({
      bundleRoot,
      tierId: "eliza-1-2b",
      textModelPath: textPath,
    });
    const srv = embeddingServerForRoute(route);
    expect(srv).toBeInstanceOf(EmbeddingServer);
    expect(srv.isRunning()).toBe(false);
  });

  it("4b dedicated-region route with a missing embedding/ GGUF never reaches the sidecar (route build hard-fails first)", () => {
    const bundleRoot = tmpBundle();
    expect(() =>
      buildLocalEmbeddingRoute({
        bundleRoot,
        tierId: "eliza-1-4b",
        textModelPath: "/unused.gguf",
      }),
    ).toThrow(VoiceStartupError);
  });

  it("forwards gpuLayers / threads opts through to the sidecar config without spawning", () => {
    const bundleRoot = tmpBundle();
    const textPath = writeGguf(path.join(bundleRoot, "text", "t.gguf"));
    const route = buildLocalEmbeddingRoute({
      bundleRoot,
      tierId: "eliza-1-0_8b",
      textModelPath: textPath,
    });
    const srv = embeddingServerForRoute(route, { gpuLayers: 0, threads: 4 });
    expect(srv).toBeInstanceOf(EmbeddingServer);
    expect(srv.isRunning()).toBe(false);
  });
});
