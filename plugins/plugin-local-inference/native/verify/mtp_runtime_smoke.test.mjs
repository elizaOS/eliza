import assert from "node:assert/strict";
import test from "node:test";

import { parseBenchOutput } from "./mtp_runtime_smoke.mjs";

test("parses llama-cli bracket throughput summary", () => {
  const parsed = parseBenchOutput(
    "main: decoded text\n[ Prompt: 506.9 t/s | Generation: 105.1 t/s ]\n",
  );

  assert.equal(parsed.tokensPerSecond, 105.1);
});

test("parses llama.cpp eval performance counters", () => {
  const parsed = parseBenchOutput(
    [
      "llama_perf_context_print:        eval time =    1234.00 ms /   128 runs   (    9.64 ms per token,   103.73 tokens per second)",
      "llama_perf_sampler_print:    sample time =      24.00 ms /   128 runs   (    0.19 ms per token,  5333.33 tokens per second)",
    ].join("\n"),
  );

  assert.equal(parsed.tokensPerSecond, 103.73);
});
