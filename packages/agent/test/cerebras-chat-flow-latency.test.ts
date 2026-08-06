/**
 * Validates source integrity, deterministic statistics, and proof checks used
 * by the live Cerebras harness; provider execution remains in the live lane.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureModelInput,
  distribution,
  modelUsageEvidence,
  percentile,
  promptCacheTelemetry,
  sourceRevisionEvidence,
  verifyExactResponseParity,
  verifyProofResponse,
} from "../scripts/cerebras-chat-flow-latency";

function git(repoRoot: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
  }).trim();
}

function createCleanRepository(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "eliza-source-evidence-"));
  git(repoRoot, "init", "--quiet");
  git(repoRoot, "config", "user.email", "source-evidence@example.test");
  git(repoRoot, "config", "user.name", "Source Evidence Test");
  writeFileSync(
    join(repoRoot, ".gitignore"),
    "*.js\n*.d.mts\n*.map\nbuild/\ndist/\nnode_modules/\npackages/core/src/i18n/generated/\n",
  );
  writeFileSync(join(repoRoot, "tracked.ts"), "export const proof = true;\n");
  git(repoRoot, "add", ".gitignore", "tracked.ts");
  git(repoRoot, "commit", "--quiet", "-m", "test fixture");
  return repoRoot;
}

describe("Cerebras chat-flow latency helpers", () => {
  it("attests the exact head only for a clean source tree", () => {
    const repoRoot = createCleanRepository();
    try {
      expect(sourceRevisionEvidence(repoRoot, ["tracked.ts"])).toEqual({
        head: git(repoRoot, "rev-parse", "HEAD"),
        treeClean: true,
      });

      writeFileSync(
        join(repoRoot, "tracked.ts"),
        "export const proof = false;\n",
      );
      expect(() => sourceRevisionEvidence(repoRoot, ["tracked.ts"])).toThrow(
        "clean committed source tree",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects untracked importable source before claiming treeClean", () => {
    const repoRoot = createCleanRepository();
    try {
      writeFileSync(
        join(repoRoot, "untracked-plugin.ts"),
        "export const override = true;\n",
      );
      expect(() => sourceRevisionEvidence(repoRoot, ["."])).toThrow(
        "clean committed source tree",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects an ignored source file that can override a tracked module", () => {
    const repoRoot = createCleanRepository();
    try {
      writeFileSync(
        join(repoRoot, "tracked.js"),
        "export const proof = false;\n",
      );

      expect(() => sourceRevisionEvidence(repoRoot, ["."])).toThrow(
        "clean committed source tree",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects an ignored file that shadows a tracked module directory", () => {
    const repoRoot = createCleanRepository();
    try {
      mkdirSync(join(repoRoot, "source", "feature"), { recursive: true });
      writeFileSync(
        join(repoRoot, "source", "feature", "index.ts"),
        "export const proof = true;\n",
      );
      git(repoRoot, "add", "source/feature/index.ts");
      git(repoRoot, "commit", "--quiet", "-m", "add directory module");
      writeFileSync(
        join(repoRoot, "source", "feature.js"),
        "export const proof = false;\n",
      );

      expect(() => sourceRevisionEvidence(repoRoot, ["source"])).toThrow(
        "clean committed source tree",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("uses NUL-delimited ignored-source paths with unusual filenames", () => {
    const repoRoot = createCleanRepository();
    try {
      mkdirSync(join(repoRoot, "source"), { recursive: true });
      writeFileSync(
        join(repoRoot, "source", "line one\nline two.js"),
        "export const proof = false;\n",
      );

      expect(() => sourceRevisionEvidence(repoRoot, ["source"])).toThrow(
        "clean committed source tree",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not treat ignored dependency and build artifacts as source overrides", () => {
    const repoRoot = createCleanRepository();
    try {
      mkdirSync(join(repoRoot, "source", "build"), { recursive: true });
      mkdirSync(join(repoRoot, "source", "dist"), { recursive: true });
      mkdirSync(join(repoRoot, "source", "node_modules"), { recursive: true });
      mkdirSync(
        join(repoRoot, "packages", "core", "src", "i18n", "generated"),
        {
          recursive: true,
        },
      );
      writeFileSync(
        join(repoRoot, "source", "build", "tracked.js"),
        "built output\n",
      );
      writeFileSync(
        join(repoRoot, "source", "dist", "tracked.js"),
        "built output\n",
      );
      writeFileSync(
        join(repoRoot, "source", "node_modules", "tracked.js"),
        "dependency output\n",
      );
      writeFileSync(join(repoRoot, "source", "trace.ts.map"), "source map\n");
      writeFileSync(
        join(repoRoot, "source", "runtime-types.d.mts"),
        "export interface RuntimeTypes {}\n",
      );
      writeFileSync(
        join(
          repoRoot,
          "packages",
          "core",
          "src",
          "i18n",
          "generated",
          "validation-keyword-data.ts",
        ),
        "generated source\n",
      );

      expect(
        sourceRevisionEvidence(repoRoot, ["source", "packages/core/src"]),
      ).toEqual({
        head: git(repoRoot, "rev-parse", "HEAD"),
        treeClean: true,
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects tracked changes inside a registered submodule", () => {
    const repoRoot = createCleanRepository();
    const submoduleSource = createCleanRepository();
    try {
      git(
        repoRoot,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "--quiet",
        submoduleSource,
        "vendor/probe",
      );
      git(repoRoot, "commit", "--quiet", "-am", "add fixture submodule");
      writeFileSync(
        join(repoRoot, "vendor/probe/tracked.ts"),
        "export const proof = false;\n",
      );

      expect(() => sourceRevisionEvidence(repoRoot, ["tracked.ts"])).toThrow(
        "clean committed source tree",
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(submoduleSource, { recursive: true, force: true });
    }
  });

  it("captures exact model input with phase context without leaking unrelated fields", () => {
    const sharedBreakpoints = [{ segmentIndex: 2 }];
    expect(
      captureModelInput(
        "RESPONSE_HANDLER",
        {
          prompt: `Authorization: Bearer ${"p".repeat(40)}`,
          messages: [{ role: "user", content: "hello" }],
          promptSegments: [{ content: "hello", stable: false }],
          providerOptions: {
            cerebras: {
              prompt_cache_key: "cache-key",
              apiKey: "must-not-be-captured",
              headers: { Authorization: "Bearer must-not-be-captured" },
            },
            eliza: { cacheBreakpoints: sharedBreakpoints },
            anthropic: { cacheBreakpoints: sharedBreakpoints },
          },
          maxTokens: 128,
          stream: true,
          apiKey: "must-not-be-captured",
        },
        { phase: "sample", index: 7, proof: "SPEED-S-7" },
      ),
    ).toEqual({
      context: { phase: "sample", index: 7, proof: "SPEED-S-7" },
      modelType: "RESPONSE_HANDLER",
      prompt: expect.not.stringContaining("p".repeat(40)),
      messages: [{ role: "user", content: "hello" }],
      promptSegments: [{ content: "hello", stable: false }],
      providerOptions: {
        cerebras: {
          prompt_cache_key: "cache-key",
          apiKey: "[REDACTED]",
          headers: { Authorization: "[REDACTED]" },
        },
        eliza: { cacheBreakpoints: [{ segmentIndex: 2 }] },
        anthropic: { cacheBreakpoints: [{ segmentIndex: 2 }] },
      },
      maxTokens: 128,
      stream: true,
    });
  });

  it("breaks cycles without hiding repeated non-secret evidence", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      captureModelInput("RESPONSE_HANDLER", { providerOptions: cyclic }, null),
    ).toMatchObject({ providerOptions: { self: "[Circular]" } });
  });

  it("uses nearest-rank percentiles and reports the full distribution", () => {
    const samples = [9, 1, 5, 3, 7];
    expect(
      percentile(
        [...samples].sort((a, b) => a - b),
        95,
      ),
    ).toBe(9);
    expect(distribution(samples)).toEqual({
      count: 5,
      min: 1,
      p50: 5,
      p90: 9,
      p95: 9,
      p99: 9,
      max: 9,
      mean: 5,
    });
  });

  it("accepts punctuation around a distinct proof and rejects stale output", () => {
    expect(() =>
      verifyProofResponse('"SPEED-S-4".', "SPEED-S-4"),
    ).not.toThrow();
    expect(() => verifyProofResponse("SPEED-S-3", "SPEED-S-4")).toThrow(
      "did not contain the requested proof",
    );
  });

  it("requires the append-only stream to equal the authoritative final reply", () => {
    expect(() =>
      verifyExactResponseParity("SPEED-S-4", "SPEED-S-4"),
    ).not.toThrow();
    expect(() => verifyExactResponseParity("SPEED-", "SPEED-S-4")).toThrow(
      "did not exactly match",
    );
  });

  it("retains concrete Cerebras model and token attribution", () => {
    expect(
      modelUsageEvidence(
        {
          runtime: {} as never,
          source: "openai",
          provider: "cerebras",
          type: "RESPONSE_HANDLER",
          model: "gemma-4-31b",
          modelName: "gemma-4-31b",
          modelLabel: "RESPONSE_HANDLER",
          tokens: {
            prompt: 120,
            completion: 8,
            total: 128,
            cachedInputTokens: 64,
          },
        },
        "gemma-4-31b",
      ),
    ).toEqual({
      provider: "cerebras",
      model: "gemma-4-31b",
      modelName: "gemma-4-31b",
      modelLabel: "RESPONSE_HANDLER",
      type: "RESPONSE_HANDLER",
      tokens: {
        prompt: 120,
        completion: 8,
        total: 128,
        cachedInputTokens: 64,
      },
    });
  });

  it("reports provider-measured cache reuse without a pass/fail threshold", () => {
    expect(
      promptCacheTelemetry([
        {
          modelUsage: {
            tokens: { prompt: 1_000, cachedInputTokens: 750 },
          },
        },
        {
          modelUsage: {
            tokens: { prompt: 2_000, cacheReadInputTokens: 1_000 },
          },
        },
      ]),
    ).toEqual({
      promptTokens: {
        count: 2,
        min: 1_000,
        p50: 1_000,
        p90: 2_000,
        p95: 2_000,
        p99: 2_000,
        max: 2_000,
        mean: 1_500,
      },
      cachedPromptTokens: {
        count: 2,
        min: 750,
        p50: 750,
        p90: 1_000,
        p95: 1_000,
        p99: 1_000,
        max: 1_000,
        mean: 875,
      },
      uncachedPromptTokens: {
        count: 2,
        min: 250,
        p50: 250,
        p90: 1_000,
        p95: 1_000,
        p99: 1_000,
        max: 1_000,
        mean: 625,
      },
      cacheRatePercent: {
        count: 2,
        min: 50,
        p50: 50,
        p90: 75,
        p95: 75,
        p99: 75,
        max: 75,
        mean: 62.5,
      },
    });
    expect(() =>
      promptCacheTelemetry([{ modelUsage: { tokens: { prompt: 100 } } }]),
    ).toThrow("provider-reported cached prompt tokens");
  });

  it("rejects logical slots and transport labels as concrete attribution", () => {
    expect(() =>
      modelUsageEvidence(
        {
          runtime: {} as never,
          source: "openai",
          provider: "openai",
          type: "RESPONSE_HANDLER",
          model: "RESPONSE_HANDLER",
          modelName: "RESPONSE_HANDLER",
          tokens: { prompt: 1, completion: 1, total: 2 },
        },
        "gemma-4-31b",
      ),
    ).toThrow("Expected MODEL_USED provider cerebras");
  });
});
