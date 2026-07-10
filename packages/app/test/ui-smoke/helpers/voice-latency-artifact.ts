/**
 * Latency + trace-completeness artifact harvester for the voice PWA E2E lane.
 * NO production code — a Playwright helper. CONSUMER-ONLY: it never defines a
 * performance mark. It harvests the `voice.*` performance measures emitted by
 * the app instrumentation (frontier audit §8.2; landed by #15931's
 * markSharedRuntimeVoiceTrace) plus the AudioContext playback-probe timeline,
 * and writes one JSON artifact per test to `test-results/.voice/`.
 *
 * When the marks are absent (a build predating #15931), `marksPresent` is false
 * and the caller's trace assertions must skip — the artifact is still written
 * (with whatever probe data exists) so the runbook always has something.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";

export interface VoiceMeasure {
  name: string;
  startTime: number;
  duration: number;
}

export interface VoiceLatencyArtifact {
  title: string;
  project: string;
  capturedAt: string;
  marksPresent: boolean;
  measures: VoiceMeasure[];
  /** Ordered `voice.*` measure names present, for completeness-chain checks. */
  chain: string[];
  /** AudioContext playback probe, when a spec installed one. */
  audioProbe?: {
    starts: number;
    stops: number;
    disconnects: number;
    ended: number;
  };
  /** Any spec-supplied derived latencies (ms). */
  derived?: Record<string, number>;
}

/**
 * Read every `performance` measure/mark whose name starts with `voice.` and
 * return a normalized snapshot. Marks are read as zero-duration measures.
 */
export async function harvestVoiceMeasures(
  page: Page,
): Promise<VoiceMeasure[]> {
  return page.evaluate(() => {
    const out: Array<{ name: string; startTime: number; duration: number }> =
      [];
    const measures = performance.getEntriesByType("measure");
    for (const m of measures) {
      if (m.name.startsWith("voice.")) {
        out.push({
          name: m.name,
          startTime: m.startTime,
          duration: (m as PerformanceMeasure).duration,
        });
      }
    }
    const marks = performance.getEntriesByType("mark");
    for (const mk of marks) {
      if (mk.name.startsWith("voice.")) {
        out.push({ name: mk.name, startTime: mk.startTime, duration: 0 });
      }
    }
    out.sort((a, b) => a.startTime - b.startTime);
    return out;
  });
}

/**
 * Harvest, assemble, and persist the artifact. Returns it so the spec can
 * assert on `marksPresent` / `chain` and decide whether to run trace checks.
 */
export async function writeVoiceLatencyArtifact(
  page: Page,
  testInfo: TestInfo,
  extra: {
    audioProbe?: VoiceLatencyArtifact["audioProbe"];
    derived?: Record<string, number>;
  } = {},
): Promise<VoiceLatencyArtifact> {
  const measures = await harvestVoiceMeasures(page);
  const chain = measures.map((m) => m.name);
  const artifact: VoiceLatencyArtifact = {
    title: testInfo.title,
    project: testInfo.project.name,
    capturedAt: new Date().toISOString(),
    marksPresent: measures.length > 0,
    measures,
    chain,
    ...(extra.audioProbe ? { audioProbe: extra.audioProbe } : {}),
    ...(extra.derived ? { derived: extra.derived } : {}),
  };
  const dir = path.join(testInfo.project.outputDir ?? "test-results", ".voice");
  try {
    mkdirSync(dir, { recursive: true });
    const safe = testInfo.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 80);
    const file = path.join(
      dir,
      `latency-${testInfo.project.name}-${safe}.json`,
    );
    writeFileSync(file, JSON.stringify(artifact, null, 2));
    await testInfo.attach("voice-latency", {
      body: JSON.stringify(artifact, null, 2),
      contentType: "application/json",
    });
  } catch {
    // artifact write is best-effort; never fail a spec on IO
  }
  return artifact;
}

/**
 * Assert the completeness chain appears in the expected order. Only meaningful
 * when `artifact.marksPresent` is true; callers guard with test.skip otherwise.
 * `expectedOrder` is a subsequence — the chain may contain extra marks between.
 */
export function chainContainsInOrder(
  chain: string[],
  expectedOrder: string[],
): boolean {
  let i = 0;
  for (const name of chain) {
    if (name === expectedOrder[i]) i += 1;
    if (i === expectedOrder.length) return true;
  }
  return i === expectedOrder.length;
}
