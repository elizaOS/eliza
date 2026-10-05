/**
 * JSON and Markdown report rendering for voice RTT runs.
 *
 * Reports include trace IDs, provider request IDs, timing summaries, and
 * lengths. Transcript text is omitted unless the operator explicitly opts into
 * unsafe artifact content.
 */

import { evaluateGates, stageAttribution, summarizeStages } from "./metrics.ts";
import type {
  BenchmarkMode,
  BenchmarkReport,
  CaseResult,
  StageDurations,
} from "./types.ts";

export function buildReport(args: {
  generatedAt: string;
  mode: BenchmarkMode;
  providers: BenchmarkReport["providers"];
  results: CaseResult[];
  enforceGates: boolean;
}): BenchmarkReport {
  const summaries = summarizeStages(args.results);
  const gates = evaluateGates({
    summaries,
    results: args.results,
    enforced: args.enforceGates,
  });
  return {
    schemaVersion: 1,
    generatedAt: args.generatedAt,
    mode: args.mode,
    providers: args.providers,
    gates,
    summaries,
    attribution: stageAttribution(summaries),
    results: args.results,
  };
}

export function renderJson(report: BenchmarkReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push("# Voice RTT Benchmark Report");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Mode: ${report.mode}`);
  lines.push(`- STT: ${report.providers.stt}`);
  lines.push(`- LLM: ${report.providers.llm}`);
  lines.push(`- TTS: ${report.providers.tts}`);
  lines.push(
    `- Gates: ${report.gates.enforced ? "enforced" : "advisory"} / ${report.gates.passed ? "PASS" : "FAIL"}`,
  );
  lines.push("");
  lines.push("## Stage Summary");
  lines.push("");
  lines.push("| Stage | n | p50 | p90 | p95 | mean | min | max |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const [stage, summary] of Object.entries(report.summaries)) {
    lines.push(
      `| ${stage} | ${summary.count} | ${fmt(summary.p50)} | ${fmt(summary.p90)} | ${fmt(summary.p95)} | ${fmt(summary.mean)} | ${fmt(summary.min)} | ${fmt(summary.max)} |`,
    );
  }
  lines.push("");
  lines.push("## P50 Attribution");
  lines.push("");
  lines.push("| Stage | p50 | Share |");
  lines.push("|---|---:|---:|");
  for (const entry of report.attribution) {
    lines.push(
      `| ${entry.stage} | ${fmt(entry.p50Ms)} | ${(entry.share * 100).toFixed(1)}% |`,
    );
  }
  lines.push("");
  lines.push("## Gates");
  lines.push("");
  lines.push(
    `- EOS to first audio P50 target: ${report.gates.eosToFirstAudioP50TargetMs}ms`,
  );
  lines.push(
    `- EOS to first audio P95 target: ${report.gates.eosToFirstAudioP95TargetMs}ms`,
  );
  lines.push(
    `- Interruption to silence target: ${report.gates.interruptToSilenceTargetMs}ms`,
  );
  if (report.gates.failures.length === 0) {
    lines.push("- Failures: none");
  } else {
    for (const failure of report.gates.failures) {
      lines.push(`- Failure: ${failure}`);
    }
  }
  lines.push("");
  lines.push("## Runs");
  lines.push("");
  lines.push(
    "| Case | Run | Trace ID | EOS→Audio | Interrupt→Silence | Cancelled | Post-interrupt audio |",
  );
  lines.push("|---|---:|---|---:|---:|---|---:|");
  for (const result of report.results) {
    lines.push(
      `| ${result.caseId} | ${result.runIndex} | ${result.trace.traceId} | ${fmt(result.stages.eosToFirstAudioMs)} | ${fmt(result.stages.interruptToSilenceMs)} | ${result.trace.cancelled ? "yes" : "no"} | ${result.trace.postInterruptAudioFrames} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function redactReport(report: BenchmarkReport): BenchmarkReport {
  return {
    ...report,
    results: report.results.map((result) => ({
      ...result,
      trace: {
        ...result.trace,
        transcript: undefined,
        replyText: undefined,
      },
    })),
  };
}

function fmt(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${Math.round(value)}ms`;
}

export type StageKey = keyof StageDurations;
