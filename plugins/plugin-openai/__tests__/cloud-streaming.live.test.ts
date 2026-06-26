import { ModelType } from "@elizaos/core";
import { expect, it } from "vitest";

import { describeLive } from "../../../packages/app-core/test/helpers/live-agent-test";
import { openaiPlugin } from "../index";

/**
 * Live end-to-end proof for #9174: a real OpenAI-compatible cloud model streams
 * its reply token-by-token through plugin-openai's AI-SDK `streamText` path,
 * firing `params.onStreamChunk` once per decoded chunk as it is generated.
 *
 * Run against any OpenAI-compatible endpoint by setting `OPENAI_BASE_URL`,
 * `OPENAI_API_KEY`, and `OPENAI_SMALL_MODEL` to a compatible chat model.
 * Skips with a warning when unset.
 */
describeLive(
  "Cloud token-by-token streaming (#9174)",
  {
    provider: "openai",
    requiredEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  },
  ({ harness }) => {
    it("fires onStreamChunk per token from a live cloud model", async () => {
      const { runtime } = harness();
      const handler = openaiPlugin.models?.[ModelType.TEXT_SMALL];
      expect(typeof handler).toBe("function");
      if (!handler) throw new Error("TEXT_SMALL handler is unavailable");

      const chunks: Array<{ atMs: number; text: string }> = [];
      const start = Date.now();

      const result = (await handler(runtime, {
        prompt: "Count from one to twelve in words, separated by spaces. Output only the words.",
        stream: true,
        onStreamChunk: (chunk: string) => {
          chunks.push({ atMs: Date.now() - start, text: chunk });
        },
      })) as {
        textStream: AsyncIterable<string>;
        text: Promise<string>;
      };

      // onStreamChunk fires as the textStream is consumed.
      let assembled = "";
      for await (const piece of result.textStream) {
        assembled += piece;
      }
      const finalText = await result.text;

      // --- Real-streaming assertions -------------------------------------
      // More than one chunk => not collapsed into a single final blob.
      expect(chunks.length).toBeGreaterThan(1);
      // Chunks arrived at distinct wall-clock times => genuine incremental
      // emission as the model generated, not a synchronous post-hoc replay.
      const distinctTimes = new Set(chunks.map((c) => c.atMs)).size;
      expect(distinctTimes).toBeGreaterThan(1);
      // The streamed deltas reconstruct the full reply.
      expect(assembled.length).toBeGreaterThan(0);
      expect(assembled).toBe(finalText);

      // --- Evidence timeline ---------------------------------------------
      console.log("\n===== #9174 LIVE CLOUD onStreamChunk TIMELINE =====");
      console.log(
        `provider base: ${runtime.getSetting("OPENAI_BASE_URL")} | model: ${runtime.getSetting(
          "OPENAI_SMALL_MODEL"
        )}`
      );
      let prev = 0;
      for (const [i, c] of chunks.entries()) {
        const gap = c.atMs - prev;
        prev = c.atMs;
        console.log(
          `chunk ${String(i + 1).padStart(2)} | t=+${String(c.atMs).padStart(
            5
          )}ms (+${String(gap).padStart(4)}ms) | ${JSON.stringify(c.text)}`
        );
      }
      console.log(
        `\nTotal onStreamChunk calls: ${chunks.length} | distinct arrival times: ${distinctTimes}`
      );
      console.log(`Reconstructed reply: ${JSON.stringify(finalText)}`);
      console.log("==================================================\n");
    }, 60_000);
  }
);
