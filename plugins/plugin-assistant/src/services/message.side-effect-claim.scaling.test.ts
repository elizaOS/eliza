/**
 * Measures the real reply-claim detector on boundary-sparse Korean questions.
 * Per-thread CPU batches distinguish scanning growth from scheduler delays;
 * the independent wall-clock check retains the per-reply latency budget.
 */
import { threadCpuUsage } from "node:process";
import { expect, it } from "vitest";
import { replyClaimsCompletedSideEffect } from "./message/side-effect-claims.ts";

it("scans near-linearly, not quadratically, as input size grows 10x", () => {
  // No punctuation, and each claim ends in a question particle: every match
  // reaches the clause lookup instead of returning at a subordinate tail.
  const unit = "알림을 설정했나요 ";
  const small = unit.repeat(Math.round(2_800 / unit.length));
  const large = unit.repeat(Math.round(28_000 / unit.length));
  expect(large.length).toBeGreaterThan(small.length * 9);

  for (let warmup = 0; warmup < 16; warmup++) {
    expect(replyClaimsCompletedSideEffect(small)).toBe(false);
    expect(replyClaimsCompletedSideEffect(large)).toBe(false);
  }

  const cpuPerReply = (input: string): number => {
    let nonAssertions = 0;
    const start = threadCpuUsage();
    for (let repetition = 0; repetition < 32; repetition++) {
      if (!replyClaimsCompletedSideEffect(input)) nonAssertions++;
    }
    const elapsed = threadCpuUsage(start);
    expect(nonAssertions).toBe(32);
    return (elapsed.user + elapsed.system) / 1_000 / 32;
  };

  const ratios: number[] = [];
  for (let round = 0; round < 7; round++) {
    // Alternate order so warmup or thermal drift does not favor one size.
    let smallCpu: number;
    let largeCpu: number;
    if (round % 2 === 0) {
      smallCpu = cpuPerReply(small);
      largeCpu = cpuPerReply(large);
    } else {
      largeCpu = cpuPerReply(large);
      smallCpu = cpuPerReply(small);
    }
    expect(smallCpu).toBeGreaterThan(0);
    ratios.push(largeCpu / smallCpu);
  }
  expect(ratios.sort((left, right) => left - right)[3]).toBeLessThan(30);

  const start = performance.now();
  const result = replyClaimsCompletedSideEffect(large);
  const elapsed = performance.now() - start;
  expect(result).toBe(false);
  expect(elapsed).toBeLessThan(200);
});
