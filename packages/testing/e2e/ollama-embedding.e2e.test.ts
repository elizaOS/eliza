import { describe, expect, it } from "bun:test";
import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { createOllamaModelHandlers } from "../src/ollama-provider";

const enabled = process.env.OLLAMA_EMBEDDING_LIVE === "1";
describe.skipIf(!enabled)("real Ollama embedding input preservation", () => {
  const embed = createOllamaModelHandlers()[ModelType.TEXT_EMBEDDING]!;
  const runtime = {} as IAgentRuntime;

  it("returns finite, nonzero, input-dependent vectors", async () => {
    const first = await embed(runtime, {
      text: "A coding agent fixes a repository issue.",
    });
    const second = await embed(runtime, {
      text: "A garden contains apple trees and flowers.",
    });
    expect(Array.isArray(first)).toBe(true);
    expect(Array.isArray(second)).toBe(true);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(first.length);
    expect((first as number[]).every(Number.isFinite)).toBe(true);
    expect((first as number[]).some((value) => value !== 0)).toBe(true);
    expect(first).not.toEqual(second);
  }, 60_000);

  it("rejects empty content rather than embedding a substitute string", async () => {
    for (const text of ["", "   "]) {
      await expect(embed(runtime, { text })).rejects.toThrow("empty text");
    }
  });

  it("rejects input beyond the configured model context instead of truncating", async () => {
    // Run with the installed nomic-embed-text model (2048-token context).
    expect(process.env.OLLAMA_EMBEDDING_MODEL).toBe("nomic-embed-text");
    await expect(
      embed(runtime, {
        text: "benchmark context preservation ".repeat(12_000),
      }),
    ).rejects.toThrow("input length exceeds the context length");
  }, 60_000);
});
