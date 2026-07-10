/**
 * Report tests verify artifact redaction and human-readable gate output.
 */

import { describe, expect, it } from "vitest";
import { createMockAdapters } from "../src/adapters/mock.ts";
import { loadCorpus } from "../src/corpus.ts";
import {
  buildReport,
  redactReport,
  renderJson,
  renderMarkdown,
} from "../src/report.ts";
import { runTurn } from "../src/run-turn.ts";

describe("reports", () => {
  it("redacts transcripts and replies by default", async () => {
    const adapters = createMockAdapters();
    const result = await runTurn({
      corpus: loadCorpus()[0],
      runIndex: 0,
      traceId: "trace-redaction",
      mode: "mock",
      stt: adapters.stt,
      llm: adapters.llm,
      tts: adapters.tts,
      timeoutMs: 1000,
      unsafeTranscripts: true,
    });
    const report = buildReport({
      generatedAt: "2026-07-10T00:00:00.000Z",
      mode: "mock",
      providers: {
        stt: adapters.stt.name,
        llm: adapters.llm.name,
        tts: adapters.tts.name,
      },
      results: [result],
      enforceGates: true,
    });
    const redacted = redactReport(report);
    const json = renderJson(redacted);
    expect(json).not.toContain(loadCorpus()[0].transcript);
    expect(json).not.toContain(loadCorpus()[0].expectedReply);
    expect(json).toContain("transcriptChars");
    expect(renderMarkdown(redacted)).toContain("Voice RTT Benchmark Report");
  });
});
