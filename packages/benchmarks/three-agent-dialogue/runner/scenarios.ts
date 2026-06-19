import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const SCENARIOS_DIR = join(PKG_DIR, "scenarios");

export interface ScenarioTurn {
  turnIdx: number;
  speaker: string;
  prompt: string;
  expectedEmotion: string;
  note: string;
}

export interface ScenarioVerificationThresholds {
  minNonEmptyTranscripts: number;
  minAudioDurationSec: number;
  minDistinctSpeakers: number;
  emotionDetectedMinFraction: number;
}

export interface Scenario {
  id: string;
  description: string;
  durationEstimateSec: number;
  smokeDurationEstimateSec: number;
  turns: ScenarioTurn[];
  smokeSubset: number[];
  verificationThresholds: ScenarioVerificationThresholds;
}

export const EDGE_VARIANTS = [
  {
    suffix: "interruption-recovery",
    name: "interruption recovery",
    prompt:
      " Brief interruption: acknowledge the previous speaker before continuing.",
    description:
      "Tests turn-taking recovery after a soft interruption without losing the thread.",
  },
  {
    suffix: "speaker-correction",
    name: "speaker correction",
    prompt:
      " If a speaker is misattributed, correct it calmly and preserve the dialogue flow.",
    description:
      "Tests diarization resilience when speaker identity is explicitly corrected.",
  },
  {
    suffix: "emotion-shift",
    name: "emotion shift",
    prompt:
      " Let the emotional tone shift more sharply while staying coherent.",
    description:
      "Tests emotion detection when a turn changes affect mid-conversation.",
  },
  {
    suffix: "longer-context",
    name: "longer context callbacks",
    prompt:
      " Refer back to an earlier point so the conversation requires context tracking.",
    description:
      "Tests whether the harness preserves cross-turn context and callbacks.",
  },
  {
    suffix: "disagreement-spike",
    name: "disagreement spike",
    prompt: " Make the disagreement direct but respectful, then repair it.",
    description:
      "Tests boundary handling around conflict, repair, and synthesis.",
  },
  {
    suffix: "quiet-speaker",
    name: "quiet speaker inclusion",
    prompt:
      " Make sure the quieter speaker gets invited back into the conversation.",
    description: "Tests balanced participation and speaker inclusion.",
  },
  {
    suffix: "overlap-caution",
    name: "overlap caution",
    prompt:
      " Avoid talking over the previous speaker; explicitly hand off the turn.",
    description:
      "Tests clean handoffs and no-overlap behavior in multi-speaker dialogue.",
  },
  {
    suffix: "meta-reflection",
    name: "meta reflection",
    prompt:
      " Include a brief reflection on how the conversation itself is changing minds.",
    description: "Tests higher-order dialogue and self-referential coherence.",
  },
  {
    suffix: "practical-resolution",
    name: "practical resolution",
    prompt: " End with a concrete next step rather than only a warm closing.",
    description:
      "Tests whether the conversation can move from abstract debate to action.",
  },
  {
    suffix: "emotion-ambiguity",
    name: "emotion ambiguity",
    prompt:
      " Make the emotion slightly mixed, such as warm but uncertain or surprised but guarded.",
    description:
      "Tests emotion detection under realistic mixed affect instead of single-note labels.",
  },
] as const;

export function baseScenarioId(scenarioId: string): string {
  const marker = "--edge-";
  if (scenarioId.includes(marker)) return scenarioId.split(marker, 1)[0];
  return scenarioId;
}

function loadBaseScenario(scenarioId: string): Scenario {
  const scenarioPath = join(SCENARIOS_DIR, `${scenarioId}.json`);
  if (!existsSync(scenarioPath)) {
    throw new Error(`Scenario not found: ${scenarioPath}`);
  }
  return JSON.parse(readFileSync(scenarioPath, "utf-8")) as Scenario;
}

export function listBaseScenarios(): string[] {
  return ["canonical"];
}

function expandScenario(
  baseId: string,
  scenario: Scenario,
  variant: (typeof EDGE_VARIANTS)[number],
): Scenario {
  return {
    ...scenario,
    id: `${baseId}--edge-${variant.suffix}`,
    description: `${scenario.description} Edge variant: ${variant.description}`,
    turns: scenario.turns.map((turn, index) => ({
      ...turn,
      prompt: index === 0 ? `${turn.prompt}${variant.prompt}` : turn.prompt,
      note: index === 0 ? `${turn.note}; ${variant.name}` : turn.note,
    })),
  };
}

export function listDialogueScenarios(): string[] {
  return [
    ...listBaseScenarios(),
    ...listBaseScenarios().flatMap((baseId) =>
      EDGE_VARIANTS.map((variant) => `${baseId}--edge-${variant.suffix}`),
    ),
  ];
}

export function loadDialogueScenario(scenarioId: string): Scenario {
  const baseId = baseScenarioId(scenarioId);
  const scenario = loadBaseScenario(baseId);
  const marker = "--edge-";
  if (!scenarioId.includes(marker)) return scenario;

  const variantSuffix = scenarioId.split(marker, 2)[1];
  const variant = EDGE_VARIANTS.find((item) => item.suffix === variantSuffix);
  if (!variant) {
    throw new Error(`Unknown scenario variant: ${scenarioId}`);
  }
  return expandScenario(baseId, scenario, variant);
}

export function countDialogueScenarios(): {
  suite: string;
  existing: number;
  added: number;
  total: number;
  multiplierAdded: number;
} {
  const existing = listBaseScenarios().length;
  const added = existing * EDGE_VARIANTS.length;
  return {
    suite: "three-agent-dialogue",
    existing,
    added,
    total: existing + added,
    multiplierAdded: added / existing,
  };
}

export function validateDialogueScenarios(): {
  valid: boolean;
  total: number;
  uniqueIds: number;
  duplicateIds: string[];
  missingTurns: string[];
  expansionMatches: boolean;
} {
  const ids = listDialogueScenarios();
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  const missingTurns = ids.filter(
    (id) => loadDialogueScenario(id).turns.length === 0,
  );
  const counts = countDialogueScenarios();
  const expansionMatches = counts.added === counts.existing * 10;
  const valid =
    duplicateIds.length === 0 && missingTurns.length === 0 && expansionMatches;
  const result = {
    valid,
    total: ids.length,
    uniqueIds: new Set(ids).size,
    duplicateIds,
    missingTurns,
    expansionMatches,
  };
  if (!valid) throw new Error(JSON.stringify(result));
  return result;
}
