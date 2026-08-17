/**
 * Proves truncation suffix-reserve batch2 (rank 8-9 systematic overflow 1-31 across 6 files).
 * Each site now reserves suffix length vs slice(0,MAX)+suffix overflow.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const root = process.cwd(); // /tmp/eliza-verify2

function read(rel: string) {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("truncation reserve batch2 — suffix length reserved", () => {
  test("optimized-prompt-resolver reserves 2 and 3 chars (600→598, head 400→397)", () => {
    const src = read("packages/core/src/services/optimized-prompt-resolver.ts");
    expect(src).toContain("candidate.slice(0, 598)");
    expect(src).toContain("rawInput.slice(0, 397)");
    expect(src).not.toContain("candidate.slice(0, 600).trimEnd()} …");
    expect(src).not.toContain("rawInput.slice(0, 400).trimEnd()");
    // overflow proof
    const candidate = "a".repeat(610);
    const weak = `${candidate.slice(0, 600).trimEnd()} …`;
    expect(weak.length).toBe(602);
    const fixed = `${candidate.slice(0, 598).trimEnd()} …`;
    expect(fixed.length).toBeLessThanOrEqual(600);
    const rawInput = "a".repeat(700);
    const weak2 = `${rawInput.slice(0, 400).trimEnd()}\n…\n${rawInput.slice(-200).trimStart()}`;
    expect(weak2.length).toBe(603);
    const fixed2 = `${rawInput.slice(0, 397).trimEnd()}\n…\n${rawInput.slice(-200).trimStart()}`;
    expect(fixed2.length).toBe(600);
  });

  test("browser-workspace sanitizer reserves 3 (500→497)", () => {
    const src = read("packages/app-core/platforms/electrobun/src/native/browser-workspace.ts");
    expect(src).toContain("MAX_EVENT_STRING_LENGTH - 3");
    expect(src).not.toContain("value.slice(0, MAX_EVENT_STRING_LENGTH)}...");
    const MAX = 500;
    const weak = "a".repeat(501).slice(0, MAX) + "...";
    expect(weak.length).toBe(503);
    const fixed = "a".repeat(501).slice(0, MAX - 3) + "...";
    expect(fixed.length).toBe(500);
  });

  test("electrobun shortError reserves suffix 31 (280→249 slice)", () => {
    const src = read("packages/app-core/platforms/electrobun/src/native/agent.ts");
    expect(src).toContain('const suffix = "... (see logs for full details)"');
    expect(src).toContain("maxLen - suffix.length");
    expect(src).not.toContain("oneLine.slice(0, maxLen)}... (see logs");
    const maxLen = 280;
    const suffix = "... (see logs for full details)";
    expect(suffix.length).toBe(31);
    const weak = "a".repeat(281).slice(0, maxLen) + suffix;
    expect(weak.length).toBe(311);
    const fixed = "a".repeat(281).slice(0, maxLen - suffix.length) + suffix;
    expect(fixed.length).toBe(280);
  });

  test("secrets-manager truncateError reserves 1 (800→799)", () => {
    const src = read("packages/app-core/src/services/secrets-manager-installer.ts");
    expect(src).toContain("clean.slice(0, max - 1)}…");
    expect(src).not.toContain("clean.slice(0, max)}…");
    const max = 800;
    const weak = "a".repeat(801).slice(0, max) + "…";
    expect(weak.length).toBe(801);
    const fixed = "a".repeat(801).slice(0, max - 1) + "…";
    expect(fixed.length).toBe(800);
  });

  test("conversation-routes snippet reserves 3 (144→141)", () => {
    const src = read("packages/agent/src/api/conversation-routes.ts");
    expect(src).toContain("MESSAGE_SEARCH_SNIPPET_RADIUS * 2 - 3");
    expect(src).not.toContain("MESSAGE_SEARCH_SNIPPET_RADIUS * 2).trimEnd()}...");
    const radius = 72;
    const MAX = radius * 2; // 144
    const weak = "a".repeat(145).slice(0, MAX).trimEnd() + "...";
    expect(weak.length).toBe(147);
    const fixed = "a".repeat(145).slice(0, MAX - 3).trimEnd() + "...";
    expect(fixed.length).toBe(144);
  });

  test("cloud-apps reference reserves 1 (120→119)", () => {
    const src = read("plugins/plugin-cloud-apps/src/client.ts");
    expect(src).toContain("collapsed.slice(0, 119)}…");
    expect(src).not.toContain("collapsed.slice(0, 120)}…");
    const weak = "a".repeat(121).slice(0, 120) + "…";
    expect(weak.length).toBe(121);
    const fixed = "a".repeat(121).slice(0, 119) + "…";
    expect(fixed.length).toBe(120);
  });
});
