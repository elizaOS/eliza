/**
 * Scenario catalog for the voice-loop benchmark.
 *
 * Each scenario pairs a synthetic fixture with optional scripted
 * injections (barge-in, false-EOS, etc.). The runner iterates the
 * catalog, plays each scenario through the configured driver, and emits
 * per-fixture metrics.
 */

import type { BenchAudioPayload, BenchInjection, BenchScenario } from "./types.ts";
import {
  FIXTURE_SAMPLE_RATE,
  generateAllFixtures,
  type FixtureSet,
} from "./fixtures.ts";

export interface ScenarioBuild {
  scenario: BenchScenario;
  audio: BenchAudioPayload;
}

/** Build the canonical scenario set against in-memory fixtures. */
export function buildScenarios(set: FixtureSet = generateAllFixtures()): ScenarioBuild[] {
  const make = (
    id: string,
    description: string,
    pcm: Float32Array,
    injection?: BenchInjection,
  ): ScenarioBuild => {
    const audio: BenchAudioPayload = {
      pcm,
      sampleRate: FIXTURE_SAMPLE_RATE,
      durationMs: (pcm.length / FIXTURE_SAMPLE_RATE) * 1000,
    };
    const scenario: BenchScenario = {
      id,
      description,
      fixture: {
        id,
        wavPath: `<in-memory:${id}>`,
        expectedTranscript: "<synthetic>",
        description,
      },
    };
    if (injection) scenario.injection = injection;
    return { scenario, audio };
  };

  const builds: ScenarioBuild[] = [
    make(
      "short-turn",
      "1.5s utterance, no barge-in. Baseline TTFA target < 2s.",
      set.short,
    ),
    make(
      "long-turn",
      "8s utterance. Verifier must cover the full transcript without drop.",
      set.long,
    ),
    make(
      "false-end-of-speech",
      "Mid-clause 400ms pause. Optimistic decode should fire and roll back gracefully.",
      set.falseEos,
    ),
    make(
      "barge-in",
      "User speaks for 2s, agent starts responding, user speaks again at t=3s. Hard-stop within 200ms.",
      set.long,
      {
        bargeInAtMs: 3000,
        bargeInAudio: set.bargeInOverlay,
      },
    ),
    make(
      "cold-start",
      "First turn on a fresh process (no prewarm). Captures load-side latency.",
      set.short,
    ),
    make(
      "warm-start",
      "Second turn after a prewarm. Captures steady-state TTFA.",
      set.short,
    ),
  ];
  return builds;
}

export const SCENARIO_IDS = [
  "short-turn",
  "long-turn",
  "false-end-of-speech",
  "barge-in",
  "cold-start",
  "warm-start",
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

export function isScenarioId(s: string): s is ScenarioId {
  return (SCENARIO_IDS as readonly string[]).includes(s);
}
